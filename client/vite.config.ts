import { defineConfig } from 'vite';

// The client talks to the resolver/proxy server through /api.
// In dev, Vite forwards /api to the Fastify server so the app is same-origin.
export default defineConfig({
  // GitHub Pages serves project sites under /<repo>/; set VITE_BASE=/StreamAnywhere/ in that build.
  base: process.env.VITE_BASE || '/',
  server: {
    port: 5173,
    strictPort: true,
    fs: {
      // allow importing ../shared/types.ts
      allow: ['..'],
    },
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET || 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2020',
  },
});
