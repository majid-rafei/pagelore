import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { writeFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const __dirname = fileURLToPath(new URL('.', import.meta.url));

// Writes dist/.build-id after every finished build, so scripts/sync-dist.* know
// when a complete build is ready to copy (never a half-written dist/).
const buildStamp = () => ({
  name: 'build-stamp',
  closeBundle() {
    writeFileSync(resolve(__dirname, 'dist/.build-id'), String(Date.now()));
  }
});

// Empties dist/ before a build but keeps dist/models/: model files that versions before 0.3 could
// read from there (often gigabytes). They are no longer used; delete that folder yourself.
const cleanKeepModels = () => ({
  name: 'clean-keep-models',
  apply: 'build',
  buildStart() {
    const out = resolve(__dirname, 'dist');
    if (!existsSync(out)) return;
    for (const name of readdirSync(out)) if (name !== 'models') rmSync(resolve(out, name), { recursive: true, force: true });
  }
});

// `vite build --watch` only rebuilds for files in the bundle; public/ (content.js, service-worker.js,
// manifest.json) is just copied. Watch those files too, so editing them also gives a fresh dist/.
const watchPublic = () => ({
  name: 'watch-public',
  apply: 'build',
  buildStart() {
    const walk = (dir) => readdirSync(dir, { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? walk(resolve(dir, e.name)) : [resolve(dir, e.name)]));
    for (const file of walk(resolve(__dirname, 'public'))) this.addWatchFile(file);
  }
});

export default defineConfig({
  base: './',
  plugins: [cleanKeepModels(), watchPublic(), buildStamp()],
  publicDir: 'public',
  build: {
    outDir: 'dist',
    // `npm run watch`: file-change events don't arrive on some file systems (Docker or WSL mounts,
    // network drives), so poll for changes instead. Plain `vite build` must keep watch off (null).
    watch: process.argv.includes('--watch') ? { chokidar: { usePolling: true, interval: 500 } } : null,
    emptyOutDir: false, // see cleanKeepModels
    rollupOptions: {
      input: {
        sidepanel: resolve(__dirname, 'sidepanel.html')
      }
    }
  }
});
