import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Point the package name at the workspace source so the example runs
      // without building/publishing first. Published consumers import
      // `modelhitch` and `modelhitch/react` from node_modules instead.
      modelhitch: path.resolve(root, '../../src/index.ts'),
      'modelhitch/react': path.resolve(root, '../../src/react/index.ts'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // Optional: forward /bridge to the local bridge server.
      '/bridge': {
        target: 'http://127.0.0.1:3939',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/bridge/, ''),
      },
    },
  },
});
