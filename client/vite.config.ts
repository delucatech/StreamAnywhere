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
  plugins: [
    {
      // The launcher is the landing page in dev too (the server serves home.html as the index in production).
      name: 'home-is-index',
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          if (req.url === '/' || req.url?.startsWith('/?')) req.url = '/home.html' + (req.url.slice(1) || '');
          next();
        });
      },
    },
  ],
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
      // The site-password page (the server sets the cookie the /api calls then carry)
      '/login': {
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
        home: path.resolve(__dirname, 'home.html'),
        main: path.resolve(__dirname, 'index.html'),
        feed: path.resolve(__dirname, 'feed.html'),
        download: path.resolve(__dirname, 'download.html'),
      },
    },
  },
  };
});
