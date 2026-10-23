import { useCallback, useRef, useState } from 'react';
import { AmazonAdapter, type SelfTestResult } from '../adapter/amazon';
import { loadSettings } from '../shared/settings';

/**
 * Connects to the open Amazon Photos tab and runs the self-test. Every scan and
 * trash step calls `ready()` first, so a broken endpoint fails before anything runs.
 */
export function useAdapter() {
  const ref = useRef<AmazonAdapter | null>(null);
  const [test, setTest] = useState<SelfTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  const ready = useCallback(async (): Promise<AmazonAdapter> => {
    setTesting(true);
    setError(null);
    try {
      const settings = await loadSettings();
      const a = await AmazonAdapter.connect(settings.apiDelayMs);
      const result = await a.selfTest();
      setTest(result);
      if (!result.ok) {
        const failed = result.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
        throw new Error(`Self-test failed. Amazon may have changed its web API; nothing was scanned or trashed.\n${failed.join('\n')}`);
      }
      ref.current = a;
      return a;
    } catch (e) {
      ref.current = null;
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      throw e;
    } finally {
      setTesting(false);
    }
  }, []);

  /** The connected adapter without re-testing, for read-only calls such as thumbnails. */
  const current = useCallback(async (): Promise<AmazonAdapter> => {
    if (ref.current) return ref.current;
    const settings = await loadSettings();
    const a = await AmazonAdapter.connect(settings.apiDelayMs);
    await a.loadOwnerId();
    ref.current = a;
    return a;
  }, []);

  return { ready, current, test, error, testing };
}
