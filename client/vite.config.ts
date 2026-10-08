import * as path from 'node:path';
import { defineConfig, loadEnv } from 'vite';

// The client talks to the resolver/proxy server through /api.
// In dev, Vite forwards /api to the Fastify server so the app is same-origin.
export default defineConfig(({ mode }) => {
  // client/.env.local (git-ignored) may hold VITE_API_TARGET / VITE_PORT for a second dev instance.
  const env = { ...loadEnv(mode, __dirname, 'VITE_'), ...process.env };
  return {
  // GitHub Pages serves project sites under /<repo>/; set VITE_BASE=/StreamAnywhere/ in that build.
  base: env.VITE_BASE || '/',
  server: {
    port: Number(env.VITE_PORT) || 5173,
    strictPort: true,
    fs: {
      // allow importing ../shared/types.ts
      allow: ['..'],
    },
    proxy: {
      '/api': {
        target: env.VITE_API_TARGET || 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2020',
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        feed: path.resolve(__dirname, 'feed.html'),
      },
    },
  },
  };
});
