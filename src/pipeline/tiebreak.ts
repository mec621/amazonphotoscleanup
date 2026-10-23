// Optional Claude tiebreaker: when the top two shots in a group score within a
// few points, send both thumbnails (and nothing else) to Claude with your own
// API key and ask which to keep. Off by default.

import Anthropic from '@anthropic-ai/sdk';
import type { AmazonAdapter } from '../adapter/amazon';
import { getMeta, setMeta } from '../db/store';
import type { Group } from '../shared/types';
import { closeCallPair, type Tiebreak, type Tiebreaks } from './group';
import type { OnProgress } from './scan';

const MODEL = 'claude-opus-5-5';
/** Safety cap on API calls per scan. */
const MAX_PER_RUN = 200;
const MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
type MediaType = (typeof MEDIA_TYPES)[number];

const PROMPT = `These are two near-identical photos taken seconds apart (Photo A, then Photo B). The owner wants to keep only one.
Pick the better shot to keep. Judge focus and motion blur, whether people's eyes are open, expressions, framing, and exposure.
Reply with your choice and a reason of at most eight words, written for the owner (for example "sharper, both kids looking at camera").`;

const SCHEMA = {
  type: 'object',
  properties: {
    choice: { type: 'string', enum: ['A', 'B'] },
    reason: { type: 'string' },
  },
  required: ['choice', 'reason'],
  additionalProperties: false,
};

async function imageBlock(blob: Blob): Promise<Anthropic.Beta.BetaImageBlockParam> {
  const media_type = (MEDIA_TYPES as readonly string[]).includes(blob.type) ? (blob.type as MediaType) : 'image/jpeg';
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { type: 'image', source: { type: 'base64', media_type, data: btoa(s) } };
}

async function ask(client: Anthropic, a: Blob, b: Blob): Promise<{ choice: 'A' | 'B'; reason: string } | null> {
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 1024,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    // A two-image comparison doesn't need deep reasoning.
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'Photo A:' }, await imageBlock(a), { type: 'text', text: 'Photo B:' }, await imageBlock(b), { type: 'text', text: PROMPT }],
      },
    ],
  });
  if (response.stop_reason === 'refusal') return null;
  const text = response.content.find((c): c is Anthropic.Beta.BetaTextBlock => c.type === 'text')?.text;
  if (!text) return null;
  const parsed = JSON.parse(text) as { choice: 'A' | 'B'; reason: string };
  return parsed.choice === 'A' || parsed.choice === 'B' ? parsed : null;
}

export async function loadTiebreaks(): Promise<Tiebreaks> {
  return (await getMeta<Tiebreaks>('tiebreaks')) ?? {};
}

/** Asks Claude about every close call that doesn't have an answer yet. */
export async function runTiebreaks(adapter: AmazonAdapter, groups: Group[], apiKey: string, onProgress: OnProgress, signal: AbortSignal): Promise<{ asked: number; skipped: number; warnings: string[] }> {
  const tiebreaks = await loadTiebreaks();
  const todo = groups
    .map((g) => ({ g, pair: closeCallPair(g) }))
    .filter((x): x is { g: Group; pair: [string, string] } => x.pair !== null && tiebreaks[x.g.id]?.pair.join() !== x.pair.join());
  const batch = todo.slice(0, MAX_PER_RUN);
  const warnings: string[] = [];
  if (todo.length > batch.length) warnings.push(`Claude tiebreaker: ${todo.length - batch.length} close calls left for the next scan (limit ${MAX_PER_RUN} per scan).`);

  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  let asked = 0;
  let skipped = 0;
  for (const [i, { g, pair }] of batch.entries()) {
    if (signal.aborted) throw new DOMException('Scan stopped', 'AbortError');
    onProgress({ phase: 'Asking Claude about close calls', done: i, total: batch.length });
    try {
      const [a, b] = await Promise.all(pair.map((id) => adapter.fetchThumbnail(id)));
      const answer = await ask(client, a, b);
      if (!answer) {
        skipped++;
        continue;
      }
      const tb: Tiebreak = { pair, winnerId: answer.choice === 'A' ? pair[0] : pair[1], reason: answer.reason.slice(0, 80) };
      tiebreaks[g.id] = tb;
      await setMeta('tiebreaks', tiebreaks);
      asked++;
    } catch (e) {
      // A bad key or exhausted credit fails every call the same way; stop rather than repeat it.
      if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError || e instanceof Anthropic.BadRequestError) {
        warnings.push(`Claude tiebreaker stopped: ${e.message}`);
        break;
      }
      skipped++;
      if (skipped <= 3) warnings.push(`Claude tiebreaker: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { asked, skipped, warnings };
}
