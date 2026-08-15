import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Production pattern: proxy provider traffic to a bridge service from
      // the app's own origin (e.g. `/v1` → http://127.0.0.1:3939) so the
      // browser never talks to providers directly — avoids CORS and keeps
      // keys server-side. Optional in dev because the demo uses an absolute
      // bridge URL (VITE_BRIDGE_URL, default http://127.0.0.1:3939/v1).
      '/bridge': {
        target: 'http://127.0.0.1:3939',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/bridge/, ''),
      },
    },
  },
});
