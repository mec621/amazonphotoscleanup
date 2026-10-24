import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { allRuns, clearAll, getMeta, itemCount } from '../../db/store';
import { analyzeCandidates } from '../../pipeline/analyze';
import { restoreRun } from '../../pipeline/apply';
import { loadGroups, loadScope, loadScopeSetting, saveScopeSetting, scopeLabel, summarize, type Summary } from '../../pipeline/library';
import { scanAlbums, scanMetadata, type Progress } from '../../pipeline/scan';
import { runTiebreaks } from '../../pipeline/tiebreak';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type Settings } from '../../shared/settings';
import type { Album, Scope, TrashRun } from '../../shared/types';
import { ProgressBar, SelfTestPanel, SettingsForm } from '../components';
import { useAdapter } from '../useAdapter';
import '../common.css';

function App() {
  const adapter = useAdapter();
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [scope, setScope] = useState<Scope>({ kind: 'all' });
  const [albums, setAlbums] = useState<Album[]>([]);
  const [years, setYears] = useState<number[]>([]);
  const [indexed, setIndexed] = useState(0);
  const [summary, setSummary] = useState<Summary | null>(null);
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
    const { groups, items } = await loadGroups(sc, s);
    setSummary(items.length ? summarize(groups) : null);
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
      if (meta.skippedShared) n.push(`Skipped ${meta.skippedShared} photos uploaded by someone else.`);
      if (meta.found === 0) n.push(`Amazon has no photos in ${scopeLabel(scope)}.`);
      try {
        await scanAlbums(a, setProgress, ctrl.signal);
      } catch (e) {
        if ((e as Error).name === 'AbortError') throw e;
        n.push(`Could not read albums, so album photos are not protected yet: ${String(e)}`);
      }
      const items = await loadScope(scope);
      const res = await analyzeCandidates(a, items, settings, setProgress, ctrl.signal);
      if (res.failed) n.push(`${res.failed} thumbnails could not be analyzed.`);
      n.push(...res.warnings);
      if (settings.claudeTiebreaker && settings.anthropicApiKey) {
        const { groups } = await loadGroups(scope, settings);
        const tb = await runTiebreaks(a, groups, settings.anthropicApiKey, setProgress, ctrl.signal);
        if (tb.asked) n.push(`Claude settled ${tb.asked} close calls.`);
        n.push(...tb.warnings);
      }
      setNotes(n);
    } catch (e) {
      if ((e as Error).name === 'AbortError') setNotes(['Scan stopped. Scan again to resume where it left off.']);
      else setError(e instanceof Error ? e.message : String(e));
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

  return (
    <>
      <section>
        <h1>Amazon Photos Cleanup</h1>
        <small>{indexed.toLocaleString()} photos indexed</small>
      </section>

      <SelfTestPanel test={adapter.test} error={adapter.error} testing={adapter.testing} onRetry={() => adapter.ready({ fresh: true }).catch(() => {})} />

      <section className="stack">
        <div className="row">
          <label>Scope</label>
          <select value={scopeValue} onChange={(e) => onScope(e.target.value)} disabled={busy}>
            <option value="all">All photos</option>
            {years.map((y) => (
              <option key={y} value={`y:${y}`}>
                {y}
              </option>
            ))}
            {albums.map((a) => (
              <option key={a.id} value={`a:${a.id}`}>
                Album: {a.name}
              </option>
            ))}
          </select>
        </div>
        <div className="row">
          {busy && abort.current ? (
            <button onClick={() => abort.current?.abort()}>Stop</button>
          ) : (
            <button className="primary" onClick={scan} disabled={busy}>
              Scan
            </button>
          )}
          {scope.kind === 'album' && <small>Album scope scans the whole library index, then analyzes the album.</small>}
        </div>
        {progress && <ProgressBar progress={progress} />}
        {adapter.waitMessage && <small className="warn">{adapter.waitMessage}</small>}
        {error && <div className="error">{error}</div>}
        {notes.map((n, i) => (
          <small key={i} className="warn">
            {n}
          </small>
        ))}
      </section>

      {summary && (
        <section className="stack">
          <h2>{scopeLabel(scope)}</h2>
          <div className="stats">
            <span>Exact duplicates</span>
            <b>{summary.exactCopies.toLocaleString()}</b>
            <span>Photos in similar groups</span>
            <b>{summary.nearPhotos.toLocaleString()}</b>
            <span>Similar groups</span>
            <b>{summary.nearGroups.toLocaleString()}</b>
            <span>Suggested for trash</span>
            <b>{summary.suggested.toLocaleString()}</b>
          </div>
          <div className="row">
            <button className="primary" onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/review/index.html') })}>
              Review
            </button>
          </div>
        </section>
      )}

      {lastRun && (
        <section className="stack">
          <h2>Last run</h2>
          <small>
            {new Date(lastRun.startedAt).toLocaleString()}: {lastRun.trashedIds.length} photos trashed, status {lastRun.status}
            {lastRun.error ? ` (${lastRun.error})` : ''}
          </small>
          {(lastRun.trashedIds.length > 0 || Boolean(lastRun.inFlightIds?.length)) && lastRun.status !== 'restored' && (
            <div className="row">
              <button onClick={undo} disabled={busy}>
                Undo last run
              </button>
            </div>
          )}
        </section>
      )}

      <section>
        <details>
          <summary>Settings</summary>
          <SettingsForm
            settings={settings}
            onChange={async (s) => {
              const clean = await saveSettings(s);
              setSettings(clean);
              await refresh(clean, scope);
            }}
          />
          <div className="row" style={{ marginTop: 12 }}>
            <button
              className="small"
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
      </section>
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
