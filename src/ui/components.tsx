import { useState } from 'react';
import type { SelfTestResult } from '../adapter/amazon';
import type { Progress } from '../pipeline/scan';
import type { Settings } from '../shared/settings';

export function ProgressBar({ progress }: { progress: Progress }) {
  const pct = progress.total ? Math.min(100, (100 * progress.done) / progress.total) : 0;
  return (
    <div className="stack" style={{ gap: 4 }}>
      <div className="bar">
        <div style={{ width: `${pct}%` }} />
      </div>
      <small>
        {progress.phase}: {progress.done.toLocaleString()} / {progress.total.toLocaleString()}
        {progress.message ? ` · ${progress.message}` : ''}
      </small>
    </div>
  );
}

export function SelfTestPanel({ test, error, testing, onRetry }: { test: SelfTestResult | null; error: string | null; testing: boolean; onRetry: () => void }) {
  const [copied, setCopied] = useState(false);
  const status = testing ? 'Checking Amazon connection…' : error ? 'Not connected' : test?.ok ? 'Connected; self-test passed' : 'Not checked';
  return (
    <section className="stack">
      <details open={Boolean(error)}>
        <summary className={error ? 'error' : test?.ok ? 'ok' : undefined}>{status}</summary>
        <div className="stack" style={{ marginTop: 8 }}>
          {error && !test && <div className="error">{error}</div>}
          {test && (
            <ul className="checks">
              {test.checks.map((c) => (
                <li key={c.name}>
                  <span className={c.ok ? 'ok' : 'error'}>{c.ok ? '✓' : '✗'}</span>
                  <span>
                    {c.name} <small>{c.detail}</small>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="row">
            <button className="small" onClick={onRetry} disabled={testing}>
              Run self-test
            </button>
            {test?.sample !== undefined && (
              <button
                className="small"
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
    </section>
  );
}

type NumKey = { [K in keyof Settings]: Settings[K] extends number ? K : never }[keyof Settings];
type BoolKey = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings];

const NUMBERS: { key: NumKey; label: string; step: number; min: number; max: number }[] = [
  { key: 'windowSeconds', label: 'Time window (seconds)', step: 1, min: 2, max: 60 },
  { key: 'phashMaxBits', label: 'Max hash difference (bits)', step: 1, min: 0, max: 32 },
  { key: 'cosineMin', label: 'Min embedding similarity', step: 0.01, min: 0.5, max: 1 },
  { key: 'groupCap', label: 'Max group size', step: 1, min: 2, max: 200 },
  { key: 'apiDelayMs', label: 'Delay between API calls (ms)', step: 50, min: 100, max: 10000 },
  { key: 'trashBatchSize', label: 'Photos per trash call', step: 1, min: 1, max: 50 },
  { key: 'trashDelayMs', label: 'Delay between trash calls (ms)', step: 100, min: 500, max: 60000 },
];

const TOGGLES: { key: BoolKey; label: string }[] = [
  { key: 'useEmbeddings', label: 'Embedding + aesthetic model (CLIP, ~90 MB, downloaded once)' },
  { key: 'useFaces', label: 'Face model for eyes open and smiles (~4 MB)' },
  { key: 'claudeTiebreaker', label: 'Ask Claude to settle close calls (your API key)' },
];

export function SettingsForm({ settings, onChange }: { settings: Settings; onChange: (s: Settings) => void }) {
  return (
    <div className="stack" style={{ marginTop: 8 }}>
      {NUMBERS.map((n) => (
        <label key={n.key} className="field">
          {n.label}
          <input type="number" step={n.step} min={n.min} max={n.max} value={settings[n.key]} onChange={(e) => onChange({ ...settings, [n.key]: Number(e.target.value) })} />
        </label>
      ))}
      {TOGGLES.map((t) => (
        <label key={t.key} className="row" style={{ fontSize: 13 }}>
          <input type="checkbox" checked={settings[t.key]} onChange={(e) => onChange({ ...settings, [t.key]: e.target.checked })} />
          {t.label}
        </label>
      ))}
      {settings.claudeTiebreaker && (
        <label className="stack" style={{ gap: 4, fontSize: 13 }}>
          Anthropic API key
          <input
            type="password"
            autoComplete="off"
            placeholder="sk-ant-…"
            value={settings.anthropicApiKey}
            onChange={(e) => onChange({ ...settings, anthropicApiKey: e.target.value.trim() })}
          />
          <small>
            Stored in this browser's extension storage. For groups whose top two scores are within 5 points, only those two thumbnails are sent to Claude, during the
            scan. Billed to this key.
          </small>
        </label>
      )}
      <small>Changing the time window or turning a model on takes effect on the next scan. Thresholds apply immediately.</small>
    </div>
  );
}
