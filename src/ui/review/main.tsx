import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AmazonAdapter } from '../../adapter/amazon';
import { allDecisions, allRuns, deleteDecision, putDecision } from '../../db/store';
import { applyTrash, rejectsFor, restoreRun } from '../../pipeline/apply';
import { memberKey } from '../../pipeline/group';
import { loadGroups, loadScopeSetting, scopeLabel } from '../../pipeline/library';
import type { Progress } from '../../pipeline/scan';
import { DEFAULT_SETTINGS, loadSettings, type Settings } from '../../shared/settings';
import type { Confidence, Decision, Group, PhotoItem, Scope, TrashRun } from '../../shared/types';
import { ProgressBar } from '../components';
import { useAdapter } from '../useAdapter';
import '../common.css';
import './review.css';

const PAGE = 25;

// ---------------------------------------------------------------------------
// Thumbnails: fetched through the adapter, a few at a time, held as object URLs.

const thumbCache = new Map<string, Promise<string>>();
let active = 0;
const queue: (() => void)[] = [];

function loadThumb(id: string, adapter: () => Promise<AmazonAdapter>): Promise<string> {
  let p = thumbCache.get(id);
  if (!p) {
    p = new Promise<void>((r) => (active < 4 ? (active++, r()) : queue.push(() => (active++, r()))))
      .then(async () => URL.createObjectURL(await (await adapter()).fetchThumbnail(id)))
      .finally(() => {
        active--;
        queue.shift()?.();
      });
    p.catch(() => thumbCache.delete(id));
    thumbCache.set(id, p);
  }
  return p;
}

function Thumb({ id, adapter }: { id: string; adapter: () => Promise<AmazonAdapter> }) {
  const [src, setSrc] = useState<string>();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let live = true;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      loadThumb(id, adapter).then((u) => live && setSrc(u), () => {});
    }, { rootMargin: '400px' });
    io.observe(el);
    return () => {
      live = false;
      io.disconnect();
    };
  }, [id, adapter]);
  return <div ref={ref}>{src ? <img className="thumb" src={src} alt="" /> : <div className="thumb" />}</div>;
}

// ---------------------------------------------------------------------------

function GroupRow({ group, items, decision, adapter, onDecide }: { group: Group; items: Map<string, PhotoItem>; decision?: Decision; adapter: () => Promise<AmazonAdapter>; onDecide: (d: Decision | null) => void }) {
  const valid = decision && decision.memberKey === memberKey(group) ? decision : undefined;
  const [draft, setDraft] = useState<string[]>(valid?.keepIds ?? group.keepIds);
  useEffect(() => setDraft(valid?.keepIds ?? group.keepIds), [valid, group]);

  const decide = (status: Decision['status'], keepIds = draft) => onDecide({ groupId: group.id, memberKey: memberKey(group), keepIds, status, decidedAt: Date.now() });
  const toggle = (id: string) => {
    if (group.members.find((m) => m.id === id)?.protected) return;
    const next = draft.includes(id) ? draft.filter((k) => k !== id) : [...draft, id];
    if (!next.length) return; // something must survive
    setDraft(next);
    if (valid?.status === 'accepted') decide('accepted', next);
  };
  const rejects = group.members.filter((m) => !draft.includes(m.id) && !m.protected).length;
  const first = items.get(group.members[0].id);

  return (
    <div className={`group ${valid?.status ?? ''}`}>
      <div className="group-head">
        <span className="badge">{group.kind === 'exact' ? 'Exact duplicates' : 'Similar shots'}</span>
        <span className={`badge ${group.confidence}`}>{group.confidence} confidence</span>
        <small>
          {first ? new Date(first.capturedAt).toLocaleString() : ''} · {group.members.length} photos · {rejects} to trash
        </small>
        <span className="spacer" />
        {valid ? (
          <>
            <b className={valid.status === 'accepted' ? 'ok' : 'muted'}>{valid.status === 'accepted' ? 'Accepted' : 'Skipped'}</b>
            <button className="small" onClick={() => onDecide(null)}>
              Undo
            </button>
          </>
        ) : (
          <>
            <button className="small primary" onClick={() => decide('accepted')}>
              Accept
            </button>
            <button className="small" onClick={() => decide('accepted', group.members.map((m) => m.id))}>
              Keep all
            </button>
            <button className="small" onClick={() => decide('skipped')}>
              Skip
            </button>
          </>
        )}
      </div>
      <div className="tiles">
        {group.members.map((m) => {
          const it = items.get(m.id);
          const keep = draft.includes(m.id) || Boolean(m.protected);
          return (
            <button key={m.id} className={`tile ${keep ? 'keep' : 'reject'} ${m.protected ? 'protected' : ''}`} onClick={() => toggle(m.id)} title={m.protected ? `Protected: ${m.protected}` : 'Click to keep or trash'}>
              <Thumb id={m.id} adapter={adapter} />
              <div className="meta">
                <span className="label">{keep ? (m.protected ? 'Keep (protected)' : 'Keep') : 'Trash'}</span>
                {group.kind === 'near' && <span>{m.score}</span>}
              </div>
              <div className="reason">{m.reason}</div>
              {it && (
                <small>
                  {it.width}×{it.height} · {(it.size / 1e6).toFixed(1)} MB
                </small>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

type KindFilter = 'all' | 'exact' | 'near';
type StatusFilter = 'all' | 'undecided' | 'accepted' | 'skipped';

function App() {
  const adapter = useAdapter();
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [scope, setScope] = useState<Scope>({ kind: 'all' });
  const [groups, setGroups] = useState<Group[]>([]);
  const [items, setItems] = useState<Map<string, PhotoItem>>(new Map());
  const [decisions, setDecisions] = useState<Map<string, Decision>>(new Map());
  const [loading, setLoading] = useState(true);
  const [kind, setKind] = useState<KindFilter>('all');
  const [year, setYear] = useState<number | 'all'>('all');
  const [minSize, setMinSize] = useState(2);
  const [confidence, setConfidence] = useState<Confidence | 'all'>('all');
  const [status, setStatus] = useState<StatusFilter>('undecided');
  const [page, setPage] = useState(0);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const [lastRun, setLastRun] = useState<TrashRun | null>(null);

  const reload = useCallback(async () => {
    const s = await loadSettings();
    const sc = await loadScopeSetting();
    const res = await loadGroups(sc, s);
    setSettings(s);
    setScope(sc);
    setGroups(res.groups);
    setItems(new Map(res.items.map((i) => [i.id, i])));
    setDecisions(await allDecisions());
    setLastRun((await allRuns())[0] ?? null);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const years = useMemo(() => [...new Set(groups.map((g) => new Date(g.capturedAt).getFullYear()))].sort((a, b) => b - a), [groups]);

  const statusOf = (g: Group) => {
    const d = decisions.get(g.id);
    return d && d.memberKey === memberKey(g) ? d.status : 'undecided';
  };

  const filtered = useMemo(
    () =>
      groups.filter(
        (g) =>
          (kind === 'all' || g.kind === kind) &&
          (year === 'all' || new Date(g.capturedAt).getFullYear() === year) &&
          g.members.length >= minSize &&
          (confidence === 'all' || g.confidence === confidence) &&
          (status === 'all' || statusOf(g) === status),
      ),
    [groups, decisions, kind, year, minSize, confidence, status],
  );

  useEffect(() => setPage(0), [kind, year, minSize, confidence, status]);

  const rejects = useMemo(() => rejectsFor(groups, decisions, items), [groups, decisions, items]);

  const onDecide = async (g: Group, d: Decision | null) => {
    const next = new Map(decisions);
    if (d) {
      await putDecision(d);
      next.set(g.id, d);
    } else {
      await deleteDecision(g.id);
      next.delete(g.id);
    }
    setDecisions(next);
  };

  const approveExact = async () => {
    const next = new Map(decisions);
    for (const g of groups) {
      if (g.kind !== 'exact' || statusOf(g) !== 'undecided') continue;
      const d: Decision = { groupId: g.id, memberKey: memberKey(g), keepIds: g.keepIds, status: 'accepted', decidedAt: Date.now() };
      await putDecision(d);
      next.set(g.id, d);
    }
    setDecisions(next);
  };

  const apply = async () => {
    if (!rejects.length) return;
    if (!confirm(`Move ${rejects.length.toLocaleString()} photos to Amazon's trash?\n\nNothing is deleted permanently. You can restore them with Undo while they are in Amazon's trash.`)) return;
    setBusy(true);
    setMessage(null);
    try {
      const a = await adapter.ready();
      const run = await applyTrash(a, rejects, settings, setProgress);
      setMessage(
        run.status === 'done'
          ? { text: `Moved ${run.trashedIds.length.toLocaleString()} photos to trash.` }
          : { text: `Stopped after ${run.trashedIds.length} of ${rejects.length}: ${run.error}`, error: true },
      );
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : String(e), error: true });
    } finally {
      setProgress(null);
      setBusy(false);
      await chrome.storage.local.set({ dataVersion: Date.now() });
      await reload();
    }
  };

  const undo = async () => {
    if (!lastRun || !confirm(`Restore ${lastRun.trashedIds.length} photos from Amazon's trash?`)) return;
    setBusy(true);
    try {
      const a = await adapter.ready();
      const r = await restoreRun(a, lastRun, settings, setProgress);
      setMessage(r.status === 'restored' ? { text: `Restored ${lastRun.items.length} photos.` } : { text: r.error ?? 'Restore failed', error: true });
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : String(e), error: true });
    } finally {
      setProgress(null);
      setBusy(false);
      await chrome.storage.local.set({ dataVersion: Date.now() });
      await reload();
    }
  };

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const shown = filtered.slice(page * PAGE, page * PAGE + PAGE);
  const undecidedExact = groups.filter((g) => g.kind === 'exact' && statusOf(g) === 'undecided').length;

  return (
    <>
      <header className="toolbar">
        <div className="row">
          <h1>Review · {scopeLabel(scope)}</h1>
          <small>
            {groups.length.toLocaleString()} groups · {filtered.length.toLocaleString()} shown
          </small>
          <span style={{ flex: 1 }} />
          <button onClick={approveExact} disabled={busy || !undecidedExact}>
            Approve all exact duplicates ({undecidedExact})
          </button>
          <button className="danger" onClick={apply} disabled={busy || !rejects.length}>
            Move {rejects.length.toLocaleString()} to trash
          </button>
          {lastRun && lastRun.trashedIds.length > 0 && lastRun.status !== 'restored' && (
            <button onClick={undo} disabled={busy}>
              Undo last run ({lastRun.trashedIds.length})
            </button>
          )}
        </div>
        <div className="row">
          <select value={kind} onChange={(e) => setKind(e.target.value as KindFilter)}>
            <option value="all">All groups</option>
            <option value="exact">Exact duplicates</option>
            <option value="near">Similar shots</option>
          </select>
          <select value={year} onChange={(e) => setYear(e.target.value === 'all' ? 'all' : Number(e.target.value))}>
            <option value="all">Any year</option>
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
          <select value={minSize} onChange={(e) => setMinSize(Number(e.target.value))}>
            {[2, 3, 5, 10].map((n) => (
              <option key={n} value={n}>
                {n}+ photos
              </option>
            ))}
          </select>
          <select value={confidence} onChange={(e) => setConfidence(e.target.value as Confidence | 'all')}>
            <option value="all">Any confidence</option>
            <option value="high">High confidence</option>
            <option value="medium">Medium confidence</option>
            <option value="low">Low confidence</option>
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
            <option value="undecided">Undecided</option>
            <option value="accepted">Accepted</option>
            <option value="skipped">Skipped</option>
            <option value="all">Any status</option>
          </select>
        </div>
        {progress && <ProgressBar progress={progress} />}
        {message && <div className={message.error ? 'error' : 'ok'}>{message.text}</div>}
        {adapter.error && <div className="error">{adapter.error}</div>}
      </header>
      <main>
        {loading && <p className="muted">Loading…</p>}
        {!loading && !groups.length && <p className="muted">No duplicate or similar groups in this scope. Run a scan from the side panel.</p>}
        {shown.map((g) => (
          <GroupRow key={g.id} group={g} items={items} decision={decisions.get(g.id)} adapter={adapter.current} onDecide={(d) => onDecide(g, d)} />
        ))}
        {pages > 1 && (
          <div className="pager">
            <button disabled={page === 0} onClick={() => (setPage(page - 1), scrollTo(0, 0))}>
              Previous
            </button>
            <small>
              Page {page + 1} of {pages}
            </small>
            <button disabled={page >= pages - 1} onClick={() => (setPage(page + 1), scrollTo(0, 0))}>
              Next
            </button>
          </div>
        )}
      </main>
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
