import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

/**
 * Copies the MediaPipe Tasks Vision WASM runtime into /public so it is served
 * locally (no CDN needed for the runtime; only the .task model is fetched).
 */
function copyMediapipeWasm(): Plugin {
  return {
    name: 'copy-mediapipe-wasm',
    buildStart() {
      const src = resolve(root, 'node_modules/@mediapipe/tasks-vision/wasm');
      const dst = resolve(root, 'public/mediapipe-wasm');
      if (!existsSync(src)) return;
      mkdirSync(dst, { recursive: true });
      cpSync(src, dst, { recursive: true });
    },
  };
}

export default defineConfig({
  plugins: [react(), copyMediapipeWasm()],
  server: { port: 5173, host: true },
  build: { chunkSizeWarningLimit: 1200 },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
} as never);
