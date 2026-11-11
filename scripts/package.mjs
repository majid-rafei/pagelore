// Build a Chrome Web Store upload: zips dist/ (manifest.json at the zip root) into release/.
// Usage: npm run package   (runs `vite build` first)
import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { zipSync } from 'fflate';

const root = new URL('..', import.meta.url).pathname;
const dist = join(root, 'dist');
const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));

const files = {};
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (dir === dist && name === 'models') continue; // locally stored model files are never shipped
    if (statSync(full).isDirectory()) { walk(full); continue; }
    if (name.startsWith('.') || name.endsWith('.map')) continue; // dev files (.build-id, source maps)
    files[relative(dist, full).split(sep).join('/')] = [readFileSync(full), { level: name.endsWith('.wasm') || name.endsWith('.png') ? 0 : 9 }];
  }
})(dist);

const out = join(root, 'release', `local-ai-assistant-${manifest.version}.zip`);
mkdirSync(join(root, 'release'), { recursive: true });
const zip = zipSync(files);
writeFileSync(out, zip);
console.log(`${Object.keys(files).length} files → ${relative(root, out)} (${(zip.length / 1e6).toFixed(1)} MB)`);
