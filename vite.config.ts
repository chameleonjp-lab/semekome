import { defineConfig } from 'vite';
import manifest from './ranking-manifest.json' with { type: 'json' };

export default defineConfig({
  base: './',
  plugins: [{
    name: 'release-contract',
    transformIndexHtml() {
      return [
        { tag: 'link', attrs: { rel: 'canonical', href: manifest.canonical_url }, injectTo: 'head' },
        { tag: 'meta', attrs: { name: 'chameleonjp-release', content: manifest.client_version }, injectTo: 'head' },
      ];
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'ranking-manifest.json', source: JSON.stringify(manifest, null, 2) });
    },
  }],
  build: { target: 'es2022' },
  server: { port: 4173, strictPort: true, hmr: process.env.SEMEKOME_BROWSER_TEST ? false : undefined },
  preview: { port: 4173, strictPort: true },
});
