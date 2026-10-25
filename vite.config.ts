import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cpSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

// Copies MediaPipe's module-worker wasm runtime into the build. MV3 forbids
// loading code from a CDN, so it must be served from the extension. (ONNX
// Runtime's wasm is emitted by Vite itself via a ?url import.)
function copyMediapipe() {
  return {
    name: 'copy-mediapipe',
    writeBundle() {
      const src = resolve(import.meta.dirname, 'node_modules/@mediapipe/tasks-vision/wasm');
      const out = resolve(import.meta.dirname, 'dist/mediapipe');
      mkdirSync(out, { recursive: true });
      for (const f of ['vision_wasm_module_internal.js', 'vision_wasm_module_internal.wasm']) cpSync(resolve(src, f), resolve(out, f));
    },
  };
}

export default defineConfig({
  plugins: [react(), copyMediapipe()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome116',
    sourcemap: true,
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      input: {
        sidepanel: resolve(import.meta.dirname, 'src/ui/sidepanel/index.html'),
        review: resolve(import.meta.dirname, 'src/ui/review/index.html'),
        history: resolve(import.meta.dirname, 'src/ui/history/index.html'),
        background: resolve(import.meta.dirname, 'src/background/index.ts'),
        content: resolve(import.meta.dirname, 'src/content/index.ts'),
        recorder: resolve(import.meta.dirname, 'src/content/recorder.ts'),
      },
      output: {
        // Scripts the manifest names directly need fixed file names.
        entryFileNames: (chunk) => (['background', 'content', 'recorder'].includes(chunk.name) ? '[name].js' : 'assets/[name]-[hash].js'),
      },
    },
  },
  worker: { format: 'es' },
});
