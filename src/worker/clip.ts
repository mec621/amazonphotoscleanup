// CLIP image embeddings plus a zero-shot aesthetic estimate, via Transformers.js.
// Loaded lazily by the feature worker. Model weights come from the Hugging Face
// Hub and are cached by the browser; the ONNX runtime is served from the extension.

// Vite emits this wasm as an extension asset; the ORT JS glue is bundled inline.
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import { AutoProcessor, AutoTokenizer, CLIPTextModelWithProjection, CLIPVisionModelWithProjection, env, RawImage, type Processor, type PreTrainedModel } from '@huggingface/transformers';

const MODEL = 'Xenova/clip-vit-base-patch32';

// Aesthetic "head": the embedding's similarity to good-photo vs bad-photo
// prompts. No extra weights to ship, and it works on the same 512-d embedding.
const GOOD = ['a beautiful, well-composed photograph', 'a high quality, sharp, professional photo'];
const BAD = ['an ugly, badly composed photograph', 'a low quality, blurry, amateur snapshot'];

let ready: Promise<{ processor: Processor; vision: PreTrainedModel; good: Float32Array; bad: Float32Array }> | null = null;

function mean(rows: Float32Array, dim: number): Float32Array {
  const out = new Float32Array(dim);
  const n = rows.length / dim;
  for (let r = 0; r < n; r++) for (let d = 0; d < dim; d++) out[d] += rows[r * dim + d] / n;
  return normalize(out);
}

function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function initClip() {
  ready ??= (async () => {
    env.allowLocalModels = false;
    env.useWasmCache = false; // the cache path imports a blob: URL, which MV3's CSP forbids
    // Setting this also stops Transformers.js defaulting to a CDN, which MV3 forbids.
    env.backends.onnx.wasm!.wasmPaths = { wasm: new URL(ortWasmUrl, self.location.href).href };
    env.backends.onnx.wasm!.numThreads = 1; // threads need cross-origin isolation
    const device = 'gpu' in navigator ? 'webgpu' : 'wasm';
    const load = async (dev: 'webgpu' | 'wasm') => {
      const [processor, vision, tokenizer, text] = await Promise.all([
        AutoProcessor.from_pretrained(MODEL),
        CLIPVisionModelWithProjection.from_pretrained(MODEL, { device: dev, dtype: 'q8' }),
        AutoTokenizer.from_pretrained(MODEL),
        CLIPTextModelWithProjection.from_pretrained(MODEL, { device: 'wasm', dtype: 'q8' }),
      ]);
      return { processor, vision, tokenizer, text };
    };
    const m = await load(device).catch(() => load('wasm'));
    const embedText = async (prompts: string[]) => {
      const { text_embeds } = await m.text(m.tokenizer(prompts, { padding: true, truncation: true }));
      return mean(text_embeds.data as Float32Array, text_embeds.dims[1]);
    };
    const good = await embedText(GOOD);
    const bad = await embedText(BAD);
    await m.text.dispose();
    return { processor: m.processor, vision: m.vision, good, bad };
  })();
  ready.catch(() => (ready = null));
  return ready;
}

export async function clipFeatures(rgba: Uint8ClampedArray, w: number, h: number): Promise<{ embedding: Float32Array; aesthetic: number }> {
  const m = await initClip();
  const image = new RawImage(rgba, w, h, 4).rgb();
  const inputs = await m.processor(image);
  const { image_embeds } = await m.vision(inputs);
  const embedding = normalize(Float32Array.from(image_embeds.data as Float32Array));
  // CLIP logit scale is 100; softmax over the two prompt sets.
  const g = Math.exp(100 * dot(embedding, m.good));
  const b = Math.exp(100 * dot(embedding, m.bad));
  return { embedding, aesthetic: g / (g + b) };
}
