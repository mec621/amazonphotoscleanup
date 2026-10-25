import { useEffect, useState } from 'react';
import type { SelfTestResult } from '../adapter/amazon';
import type { Progress } from '../pipeline/scan';
import type { Settings } from '../shared/settings';

export function ProgressBar({ progress }: { progress: Progress }) {
  const pct = progress.total ? Math.min(100, (100 * progress.done) / progress.total) : 0;
  return (
    <div className="progress">
      <div className="progress-label">
        <span>{progress.phase}</span>
        <span className="num">
          {progress.done.toLocaleString()} / {progress.total.toLocaleString()}
        </span>
      </div>
      <div className="bar">
        <div style={{ width: `${pct}%` }} />
      </div>
      {progress.message && <span className="subtle">{progress.message}</span>}
    </div>
  );
}

/** One short message box; `tone` picks the colour. */
export function Callout({ tone, children }: { tone: 'info' | 'warn' | 'error' | 'ok'; children: React.ReactNode }) {
  return <div className={`callout ${tone}`}>{children}</div>;
}

export type ConnectionState = { tone: 'ok' | 'warn' | 'error' | 'info'; label: string };

export function connectionState(test: SelfTestResult | null, error: string | null, testing: boolean): ConnectionState {
  if (testing) return { tone: 'info', label: 'Checking…' };
  if (error) return { tone: 'error', label: 'Not connected' };
  if (!test) return { tone: 'info', label: 'Not checked' };
  const warnings = test.checks.filter((c) => !c.ok && c.optional).length;
  if (warnings) return { tone: 'warn', label: `Connected · ${warnings} warning${warnings > 1 ? 's' : ''}` };
  return { tone: 'ok', label: 'Connected' };
}

export function StatusPill({ state }: { state: ConnectionState }) {
  return (
    <span className={`pill ${state.tone}`}>
      <span className="dot" />
      {state.label}
    </span>
  );
}

export function SelfTestPanel({ test, error, testing, onRetry }: { test: SelfTestResult | null; error: string | null; testing: boolean; onRetry: () => void }) {
  const [copied, setCopied] = useState(false);
  const state = connectionState(test, error, testing);
  return (
    <details className="card" open={Boolean(error)}>
      <summary>
        Connection check
        <StatusPill state={state} />
        <span className="chevron">›</span>
      </summary>
      <div className="stack" style={{ marginTop: 'var(--s3)' }}>
        {error && <Callout tone="error">{error}</Callout>}
        {test && (
          <ul className="checks">
            {test.checks.map((c) => {
              const tone = c.ok ? 'ok' : c.optional ? 'warn' : 'error';
              return (
                <li key={c.name}>
                  <span className={`icon ${tone}`}>{c.ok ? '✓' : c.optional ? '!' : '✕'}</span>
                  <span>
                    {c.name}
                    <span className="detail">{c.detail}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <div className="row">
          <button className="small" onClick={onRetry} disabled={testing}>
            Run self-test
          </button>
          {test?.sample !== undefined && (
            <button
              className="small ghost"
              onClick={async () => {
                await navigator.clipboard.writeText(JSON.stringify(test.sample, null, 2));
                setCopied(true);
              }}
            >
              {copied ? 'Copied' : 'Copy sample response'}
            </button>
          )}
        </div>
      </div>
    </details>
  );
}

type NumKey = { [K in keyof Settings]: Settings[K] extends number ? K : never }[keyof Settings];
type BoolKey = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings];
type NumField = { key: NumKey; label: string; step: number; min: number; max: number };

const MATCHING: NumField[] = [
  { key: 'windowSeconds', label: 'Time window (seconds)', step: 1, min: 2, max: 300 },
  { key: 'phashMaxBits', label: 'Max hash difference (bits)', step: 1, min: 0, max: 32 },
  { key: 'cosineMin', label: 'Min embedding similarity', step: 0.01, min: 0.5, max: 1 },
  { key: 'groupCap', label: 'Max group size', step: 1, min: 2, max: 200 },
];

const PACING: NumField[] = [
  { key: 'apiDelayMs', label: 'Delay between API calls (ms)', step: 50, min: 100, max: 10000 },
  { key: 'trashBatchSize', label: 'Photos per trash call', step: 1, min: 1, max: 50 },
  { key: 'trashDelayMs', label: 'Delay between trash calls (ms)', step: 100, min: 500, max: 60000 },
];

const TOGGLES: { key: BoolKey; label: string; hint: string }[] = [
  { key: 'useEmbeddings', label: 'Embedding + aesthetic model', hint: 'CLIP, about 90 MB, downloaded once' },
  { key: 'useFaces', label: 'Face model', hint: 'Eyes open and smiles, about 4 MB' },
  { key: 'claudeTiebreaker', label: 'Ask Claude to settle close calls', hint: 'Uses your own Anthropic API key' },
];

/** A number input that saves on blur or Enter, so half-typed values aren't clamped mid-edit. */
function NumberInput({ field, value, onCommit }: { field: NumField; value: number; onCommit: (v: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const v = Number(text);
    if (text.trim() === '' || !Number.isFinite(v)) setText(String(value));
    else if (v !== value) onCommit(v);
  };
  return (
    <input
      type="number"
      step={field.step}
      min={field.min}
      max={field.max}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

export function SettingsForm({ settings, onChange }: { settings: Settings; onChange: (s: Settings) => void }) {
  const numbers = (fields: NumField[]) =>
    fields.map((f) => (
      <label key={f.key} className="field">
        {f.label}
        <NumberInput field={f} value={settings[f.key]} onCommit={(v) => onChange({ ...settings, [f.key]: v })} />
      </label>
    ));
  return (
    <div className="stack" style={{ marginTop: 'var(--s4)', gap: 'var(--s4)' }}>
      <div className="settings-group">
        <span className="field-label">Analysis</span>
        {TOGGLES.map((t) => (
          <label key={t.key} className="check">
            <input type="checkbox" checked={settings[t.key]} onChange={(e) => onChange({ ...settings, [t.key]: e.target.checked })} />
            <span>
              {t.label}
              <span className="subtle" style={{ display: 'block' }}>
                {t.hint}
              </span>
            </span>
          </label>
        ))}
        {settings.claudeTiebreaker && (
          <label className="stack" style={{ gap: 'var(--s1)' }}>
            <span className="field-label">Anthropic API key</span>
            <input type="password" autoComplete="off" placeholder="sk-ant-…" value={settings.anthropicApiKey} onChange={(e) => onChange({ ...settings, anthropicApiKey: e.target.value.trim() })} />
            <span className="subtle">
              Stored in this browser's extension storage. For groups whose top two scores are within 5 points, only those two thumbnails are sent to Claude, during the
              scan. Billed to this key.
            </span>
          </label>
        )}
      </div>
      <div className="settings-group">
        <span className="field-label">Matching</span>
        {numbers(MATCHING)}
      </div>
      <div className="settings-group">
        <span className="field-label">Pacing</span>
        {numbers(PACING)}
      </div>
      <span className="subtle">The time window and models apply from the next scan. Thresholds apply right away.</span>
    </div>
  );
}
