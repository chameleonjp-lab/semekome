import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: { target: 'es2022' },
  server: { port: 4173, strictPort: true, hmr: process.env.SEMEKOME_BROWSER_TEST ? false : undefined },
  preview: { port: 4173, strictPort: true },
});
