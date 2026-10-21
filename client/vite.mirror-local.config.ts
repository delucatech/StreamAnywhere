import * as path from 'node:path';
import * as fs from 'node:fs';
import { defineConfig, type Plugin } from 'vite';

/**
 * Builds mirror-local.html - the viewer the iPhone app serves on its hotspot - into ONE file with
 * its script and style inlined (the phone's tiny web server hands out a single page), written to
 * mirror/ios/Shared/Resources/viewer.html:   npm run build:mirror-local -w client
 */
function inlineEverything(): Plugin {
  return {
    name: 'inline-everything',
    enforce: 'post',
    generateBundle(_opts, bundle) {
      const html = Object.values(bundle).find((b) => b.type === 'asset' && b.fileName.endsWith('.html'));
      if (!html || html.type !== 'asset') return;
      let source = String(html.source);
      source = source.replace(/<script type="module"[^>]*src="\.?\/?([^"]+)"[^>]*><\/script>/g, (_m, file: string) => {
        const chunk = bundle[file];
        if (!chunk || chunk.type !== 'chunk') return '';
        delete bundle[file];
        return `<script type="module">${chunk.code.replace(/<\/script/gi, '<\/script')}</script>`;
      });
      source = source.replace(/<link rel="stylesheet"[^>]*href="\.?\/?([^"]+)"[^>]*>/g, (_m, file: string) => {
        const asset = bundle[file];
        if (!asset || asset.type !== 'asset') return '';
        delete bundle[file];
        return `<style>${String(asset.source)}</style>`;
      });
      source = source.replace(/<link rel="modulepreload"[^>]*>/g, '');
      html.source = source;
      html.fileName = 'viewer.html';
    },
    closeBundle() {
      const built = path.resolve(__dirname, '../mirror/ios/Shared/Resources/viewer.html');
      if (fs.existsSync(built)) console.log(`mirror-local: ${built} (${(fs.statSync(built).size / 1024).toFixed(0)} KB)`);
    },
  };
}

export default defineConfig({
  base: './',
  // nothing from client/public: the phone serves this one file and nothing else
  publicDir: false,
  plugins: [inlineEverything()],
  build: {
    outDir: path.resolve(__dirname, '../mirror/ios/Shared/Resources'),
    emptyOutDir: false,
    sourcemap: false,
    target: 'es2020',
    cssCodeSplit: false,
    assetsInlineLimit: 1024 * 1024,
    rollupOptions: {
      input: path.resolve(__dirname, 'mirror-local.html'),
      output: { inlineDynamicImports: true },
    },
  },
});
