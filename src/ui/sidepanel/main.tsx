import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { allRuns, clearAll, getMeta, itemCount, setMeta } from '../../db/store';
import { analyzeCandidates } from '../../pipeline/analyze';
import { restoreRun } from '../../pipeline/apply';
import { analysisStats, loadGroups, loadScope, loadScopeSetting, saveScopeSetting, scopeLabel, summarize, type AnalysisStats, type Summary } from '../../pipeline/library';
import { scanAlbums, scanMetadata, type Progress } from '../../pipeline/scan';
import { runTiebreaks } from '../../pipeline/tiebreak';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type Settings } from '../../shared/settings';
import type { Album, Scope, TrashRun } from '../../shared/types';
import { Callout, ProgressBar, SelfTestPanel, SettingsForm } from '../components';
import { useAdapter } from '../useAdapter';
import '../fonts';
import '../common.css';
import './sidepanel.css';

function App() {
  const adapter = useAdapter();
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [scope, setScope] = useState<Scope>({ kind: 'all' });
  const [albums, setAlbums] = useState<Album[]>([]);
  const [years, setYears] = useState<number[]>([]);
  const [indexed, setIndexed] = useState(0);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [stats, setStats] = useState<AnalysisStats | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<TrashRun | null>(null);
  const abort = useRef<AbortController | null>(null);

  const refresh = useCallback(async (s: Settings, sc: Scope) => {
    setIndexed(await itemCount());
    setAlbums((await getMeta<Album[]>('albums')) ?? []);
    const all = await loadScope({ kind: 'all' });
    // Offer every year back to the oldest indexed photo (or 30 years), not only years already scanned.
    const now = new Date().getFullYear();
    const oldest = Math.min(now - 30, ...all.map((i) => i.year).filter((y) => y > 1900));
    setYears(Array.from({ length: now - oldest + 1 }, (_, i) => now - i));
    const { groups, items, features } = await loadGroups(sc, s);
    setSummary(items.length ? summarize(groups) : null);
    setStats(items.length ? analysisStats(items, features, s.windowSeconds) : null);
    // The last scan's messages survive a panel reload.
    const last = await getMeta<{ notes: string[]; error: string | null }>('lastScanNotes');
    if (last) {
      setNotes(last.notes);
      setError(last.error);
    }
    setLastRun((await allRuns())[0] ?? null);
  }, []);

  useEffect(() => {
    (async () => {
      const s = await loadSettings();
      const sc = await loadScopeSetting();
      setSettings(s);
      setScope(sc);
      await refresh(s, sc);
      adapter.ready().catch(() => {});
    })();
    // Refresh when the review tab trashes or restores something.
    const onChange = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (changes.dataVersion) loadSettings().then((s) => loadScopeSetting().then((sc) => refresh(s, sc)));
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, [adapter.ready, refresh]);

  const changeScope = async (sc: Scope) => {
    setScope(sc);
    await saveScopeSetting(sc);
    await refresh(settings, sc);
  };

  const scan = async () => {
    setBusy(true);
    setError(null);
    setNotes([]);
    const ctrl = new AbortController();
    abort.current = ctrl;
    try {
      const a = await adapter.ready();
      const meta = await scanMetadata(a, scope.kind === 'year' ? scope : { kind: 'all' }, setProgress, ctrl.signal);
      const n: string[] = [];
      if (meta.skippedShared) n.push(`Skipped ${plural(meta.skippedShared, 'photo')} uploaded by someone else.`);
      if (meta.found === 0) n.push(`Amazon has no photos in ${scopeLabel(scope)}.`);
      try {
        await scanAlbums(a, setProgress, ctrl.signal);
      } catch (e) {
        if ((e as Error).name === 'AbortError') throw e;
        n.push(`Could not read albums, so album photos are not protected yet: ${String(e)}`);
      }
      const items = await loadScope(scope);
      const res = await analyzeCandidates(a, items, settings, setProgress, ctrl.signal);
      if (res.failed) n.push(`${plural(res.failed, 'thumbnail')} could not be analyzed.`);
      n.push(...res.warnings);
      if (settings.claudeTiebreaker && settings.anthropicApiKey) {
        const { groups } = await loadGroups(scope, settings);
        const tb = await runTiebreaks(a, groups, settings.anthropicApiKey, setProgress, ctrl.signal);
        if (tb.asked) n.push(`Claude settled ${tb.asked} close calls.`);
        n.push(...tb.warnings);
      }
      setNotes(n);
      await setMeta('lastScanNotes', { notes: n, error: null });
    } catch (e) {
      const stopped = (e as Error).name === 'AbortError';
      const notes = stopped ? ['Scan stopped. Scan again to resume where it left off.'] : [];
      const error = stopped ? null : e instanceof Error ? e.message : String(e);
      setNotes(notes);
      setError(error);
      await setMeta('lastScanNotes', { notes, error });
    } finally {
      setProgress(null);
      setBusy(false);
      abort.current = null;
      await refresh(settings, scope);
    }
  };

  const undo = async () => {
    if (!lastRun || !confirm(`Restore ${lastRun.trashedIds.length} photos from Amazon's trash?`)) return;
    setBusy(true);
    setError(null);
    try {
      const a = await adapter.current();
      const r = await restoreRun(a, lastRun, settings, setProgress);
      if (r.status !== 'restored') setError(r.error ?? 'Restore failed');
      await chrome.storage.local.set({ dataVersion: Date.now() });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setProgress(null);
      setBusy(false);
      await refresh(settings, scope);
    }
  };

  const scopeValue = scope.kind === 'all' ? 'all' : scope.kind === 'year' ? `y:${scope.year}` : `a:${scope.albumId}`;
  const onScope = (v: string) => {
    if (v === 'all') return changeScope({ kind: 'all' });
    if (v.startsWith('y:')) return changeScope({ kind: 'year', year: Number(v.slice(2)) });
    const album = albums.find((a) => a.id === v.slice(2));
    if (album) changeScope({ kind: 'album', albumId: album.id, name: album.name });
  };

  const scanLabel = scope.kind === 'all' ? 'Scan all photos' : scope.kind === 'year' ? `Scan ${scope.year}` : `Scan ${scope.name}`;
  const canUndo = lastRun && (lastRun.trashedIds.length > 0 || Boolean(lastRun.inFlightIds?.length)) && lastRun.status !== 'restored';
  const analyzedPct = stats && stats.candidates ? Math.round((100 * stats.analyzed) / stats.candidates) : 100;

  return (
    <div className="panel">
      <header className="panel-header brand">
        <h1>Photo Cleanup</h1>
        <span className="eyebrow num">{indexed.toLocaleString()} photos indexed</span>
      </header>

      <SelfTestPanel test={adapter.test} error={adapter.error} testing={adapter.testing} onRetry={() => adapter.ready({ fresh: true }).catch(() => {})} />

      <section className="card stack">
        <label className="stack" style={{ gap: 'var(--s1)' }}>
          <span className="eyebrow">Scope</span>
          <select className="underline" value={scopeValue} onChange={(e) => onScope(e.target.value)} disabled={busy}>
            <option value="all">All photos</option>
            <optgroup label="Year">
              {years.map((y) => (
                <option key={y} value={`y:${y}`}>
                  {y}
                </option>
              ))}
            </optgroup>
            {albums.length > 0 && (
              <optgroup label="Album">
                {albums.map((a) => (
                  <option key={a.id} value={`a:${a.id}`}>
                    {a.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
        {busy && abort.current ? (
          <button className="block" onClick={() => abort.current?.abort()}>
            Stop
          </button>
        ) : (
          <button className="primary block" onClick={scan} disabled={busy}>
            {scanLabel}
          </button>
        )}
        {scope.kind === 'album' && <span className="subtle">Album scope indexes the whole library, then analyzes only this album.</span>}
        {progress && <ProgressBar progress={progress} />}
        {adapter.waitMessage && <Callout tone="warn">{adapter.waitMessage}</Callout>}
        {error && <Callout tone="error">{error}</Callout>}
        {notes.map((n, i) => (
          <Callout key={i} tone="info">
            {n}
          </Callout>
        ))}
      </section>

      {summary && (
        <section className="card">
          <div className="card-title">
            <h2>{scopeLabel(scope)}</h2>
            {summary.suggested > 0 && <span className="pill accent num">{summary.suggested.toLocaleString()} to review</span>}
          </div>
          <div className="tiles-grid">
            <Stat label="Exact duplicates" value={summary.exactCopies} />
            <Stat label="Similar groups" value={summary.nearGroups} />
            <Stat label="Photos in similar groups" value={summary.nearPhotos} />
            <Stat label="Suggested for trash" value={summary.suggested} accent />
          </div>
          {stats && (
            <div className="progress" style={{ marginTop: 'var(--s4)' }}>
              <div className="progress-label">
                <span>Similar-shot analysis</span>
                <span className="num">
                  {stats.analyzed.toLocaleString()} / {stats.candidates.toLocaleString()}
                </span>
              </div>
              <div className="bar">
                <div style={{ width: `${analyzedPct}%` }} />
              </div>
              <span className="subtle">Photos taken within {settings.windowSeconds}s of another, checked for near-duplicates.</span>
            </div>
          )}
          <div className="stack" style={{ marginTop: 'var(--s4)' }}>
            {stats && stats.candidates > stats.analyzed && <Callout tone="warn">Similar-shot analysis isn't finished. Scan again to continue it.</Callout>}
            {stats && summary.nearGroups === 0 && stats.analyzed > 0 && stats.analyzed === stats.candidates && (
              <Callout tone="info">
                Checked {stats.analyzed.toLocaleString()} photos taken within {settings.windowSeconds}s of another, and none looked alike enough to group. A longer time window in Settings
                compares more photos.
              </Callout>
            )}
            {stats && stats.candidates === 0 && stats.total > 0 && (
              <Callout tone="info">No photos here were taken within {settings.windowSeconds}s of each other. A longer time window in Settings compares more photos.</Callout>
            )}
            {stats && stats.midnight > stats.total / 2 && (
              <Callout tone="warn">Most capture times are exactly midnight, so Amazon may only be giving dates, not times. Similar-shot grouping needs real times.</Callout>
            )}
            <button className="primary block" onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/review/index.html') })}>
              Open review →
            </button>
          </div>
        </section>
      )}

      {lastRun && (
        <section className="card">
          <div className="card-title">
            <h2>Last run</h2>
            <span className={`pill ${lastRun.status === 'done' || lastRun.status === 'restored' ? 'ok' : lastRun.status === 'running' ? 'info' : 'error'}`}>{RUN_LABELS[lastRun.status]}</span>
          </div>
          <p className="muted" style={{ fontSize: 13 }}>
            {lastRun.trashedIds.length.toLocaleString()} photos moved to trash · {new Date(lastRun.startedAt).toLocaleString()}
          </p>
          {lastRun.error && (
            <div style={{ marginTop: 'var(--s3)' }}>
              <Callout tone="error">{lastRun.error}</Callout>
            </div>
          )}
          <button className="primary block" style={{ marginTop: 'var(--s3)' }} onClick={openHistory}>
            See trashed photos and check with Amazon
          </button>
          {canUndo && (
            <button className="block" style={{ marginTop: 'var(--s2)' }} onClick={undo} disabled={busy}>
              Undo last run
            </button>
          )}
        </section>
      )}

      <details className="card">
        <summary>
          Settings
          <span className="chevron">›</span>
        </summary>
        <SettingsForm
          albums={albums}
          settings={settings}
          onChange={async (s) => {
            const clean = await saveSettings(s);
            setSettings(clean);
            await refresh(clean, scope);
          }}
        />
        <div className="row" style={{ marginTop: 'var(--s4)', paddingTop: 'var(--s3)', borderTop: '1px solid var(--line)' }}>
          <button
            className="small ghost"
            disabled={busy}
            onClick={async () => {
              if (!confirm('Clear the local index, features and review decisions? Your Amazon library is not touched. The undo log is kept.')) return;
              await clearAll();
              await refresh(settings, scope);
            }}
          >
            Clear local index
          </button>
        </div>
      </details>
    </div>
  );
}

const openHistory = () => chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/history/index.html') });

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

const RUN_LABELS: Record<TrashRun['status'], string> = {
  running: 'Interrupted',
  done: 'Done',
  failed: 'Stopped',
  restored: 'Restored',
  'restore-failed': 'Restore failed',
};

function Stat({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className={`stat ${accent ? 'accent' : ''}`}>
      <span className="stat-value num">{value.toLocaleString()}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
