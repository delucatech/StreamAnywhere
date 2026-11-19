import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { defineConfig, loadEnv, type Plugin } from 'vite';

/** Files of client/public the service worker keeps on the device beside the pages and their scripts. */
const APP_STATIC = ['icon.svg', 'manifest.webmanifest', 'apple-touch-icon.png'];

/**
 * Writes dist/app-version.json: the version of this build and every file that belongs to it.
 * The service worker (public/sw.js) asks for it each time the app is opened; a version other than
 * the one on the device means "download this list in the background, then switch to it".
 *
 * The list is taken from the bundle, not from the folder: dist keeps earlier builds' scripts
 * (emptyOutDir is off). The version is a hash of the pages' text, the names of the scripts and
 * styles (content-hashed by the build) and the public files, so the same source gives the same
 * version and any change gives another.
 */
function appVersion(): Plugin {
  let base = '/';
  return {
    name: 'app-version',
    apply: 'build',
    enforce: 'post',
    configResolved(c) {
      base = c.base.endsWith('/') ? c.base : c.base + '/';
    },
    writeBundle(options, bundle) {
      const pages: string[] = [];
      const assets: string[] = [];
      const hash = crypto.createHash('sha256');
      for (const name of Object.keys(bundle).sort()) {
        if (name.endsWith('.map')) continue;
        const f = bundle[name]!;
        if (name.endsWith('.html')) {
          pages.push(base + name);
          hash.update(name + '\0').update(f.type === 'asset' ? f.source : f.code).update('\0');
        } else if (name.startsWith('assets/')) {
          assets.push(base + name);
          hash.update(name + '\0');
        }
      }
      const statics: string[] = [];
      for (const name of [...APP_STATIC, 'sw.js']) {
        const file = path.resolve(__dirname, 'public', name);
        if (!fs.existsSync(file)) continue;
        hash.update(name + '\0').update(fs.readFileSync(file)).update('\0');
        if (name !== 'sw.js') statics.push(base + name);
      }
      const out = { version: hash.digest('hex').slice(0, 16), built: new Date().toISOString(), pages, assets, static: statics };
      fs.writeFileSync(path.join(options.dir || path.resolve(__dirname, 'dist'), 'app-version.json'), JSON.stringify(out, null, 1));
    },
  };
}

// The client talks to the resolver/proxy server through /api.
// In dev, Vite forwards /api to the Fastify server so the app is same-origin.
export default defineConfig(({ mode }) => {
  // client/.env.local (git-ignored) may hold VITE_API_TARGET / VITE_PORT for a second dev instance.
  const env = { ...loadEnv(mode, __dirname, 'VITE_'), ...process.env };
  return {
  // GitHub Pages serves project sites under /<repo>/; set VITE_BASE=/StreamAnywhere/ in that build.
  base: env.VITE_BASE || '/',
  plugins: [
    appVersion(),
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
        // the Mirror relay (/api/mirror/ws) is a WebSocket
        ws: true,
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
    // Earlier builds' scripts and styles stay (content-hashed names never clash): a page a device
    // cached before a deploy still finds them. The VM prunes the ones older than two weeks.
    emptyOutDir: false,
    sourcemap: true,
    target: 'es2020',
    rollupOptions: {
      input: {
        home: path.resolve(__dirname, 'home.html'),
        main: path.resolve(__dirname, 'index.html'),
        feed: path.resolve(__dirname, 'feed.html'),
        download: path.resolve(__dirname, 'download.html'),
        library: path.resolve(__dirname, 'library.html'),
        livetv: path.resolve(__dirname, 'livetv.html'),
        mirror: path.resolve(__dirname, 'mirror.html'),
        mirrorSend: path.resolve(__dirname, 'mirror-send.html'),
      },
    },
  },
  };
});
