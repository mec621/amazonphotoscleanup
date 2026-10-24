import { useCallback, useRef, useState } from 'react';
import { AmazonAdapter, type SelfTestResult } from '../adapter/amazon';
import { loadSettings } from '../shared/settings';

/** A passing self-test is reused for this long before a scan; each one costs several rate-limited searches. */
const SELF_TEST_REUSE_MS = 15 * 60 * 1000;

/**
 * Connects to the open Amazon Photos tab and runs the self-test. Every scan and
 * trash step calls `ready()` first, so a broken endpoint fails before anything runs.
 */
export function useAdapter() {
  const ref = useRef<AmazonAdapter | null>(null);
  const passedAt = useRef(0);
  const [test, setTest] = useState<SelfTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [waitMessage, setWaitMessage] = useState<string | null>(null);

  const connect = useCallback(async (): Promise<AmazonAdapter> => {
    const settings = await loadSettings();
    const a = await AmazonAdapter.connect(settings.apiDelayMs);
    a.onWait = setWaitMessage;
    return a;
  }, []);

  /**
   * A connected adapter whose self-test passed. `fresh` forces a new self-test
   * (used before trashing); otherwise a pass from the last 15 minutes is reused.
   */
  const ready = useCallback(
    async (opts: { fresh?: boolean } = {}): Promise<AmazonAdapter> => {
      if (!opts.fresh && ref.current && Date.now() - passedAt.current < SELF_TEST_REUSE_MS) return ref.current;
      setTesting(true);
      setError(null);
      try {
        const a = await connect();
        const result = await a.selfTest();
        setTest(result);
        if (!result.ok) {
          const failed = result.checks.filter((c) => !c.ok && !c.optional);
          const rateLimited = failed.length > 0 && failed.every((c) => c.detail.includes('HTTP 429'));
          throw new Error(
            rateLimited
              ? "Amazon is rate-limiting this account's searches right now, so nothing was scanned. Leave it for 15–30 minutes, then click Run self-test once."
              : `Self-test failed. Amazon may have changed its web API; nothing was scanned or trashed.\n${failed.map((c) => `${c.name}: ${c.detail}`).join('\n')}`,
          );
        }
        ref.current = a;
        passedAt.current = Date.now();
        return a;
      } catch (e) {
        ref.current = null;
        passedAt.current = 0;
        setError(e instanceof Error ? e.message : String(e));
        throw e;
      } finally {
        setTesting(false);
        setWaitMessage(null);
      }
    },
    [connect],
  );

  /** The connected adapter without re-testing, for thumbnails and for restoring (undo must not depend on search). */
  const current = useCallback(async (): Promise<AmazonAdapter> => {
    if (ref.current) return ref.current;
    const a = await connect();
    await a.loadOwnerId();
    ref.current = a;
    return a;
  }, [connect]);

  return { ready, current, test, error, testing, waitMessage };
}
