// Writes public/THIRD_PARTY_NOTICES.txt from the licenses of the libraries bundled into the extension.
// Run automatically by `npm run package`.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const BUNDLED = [
  ['pdfjs-dist', 'https://github.com/mozilla/pdf.js'],
  ['fflate', 'https://github.com/101arrowz/fflate']
];

const pkgDir = (name) => [join(root, 'node_modules', name)].find((d) => existsSync(join(d, 'package.json')));

let out = 'Third-party software included in Local AI Browser Assistant\n' +
  '============================================================\n\n' +
  'No AI model is included: the extension uses the models the user sets up (Ollama, LM Studio or an API).\n\n';
for (const [name, url, inlineLicense, sameAs] of BUNDLED) {
  const dir = pkgDir(name);
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  out += `${'-'.repeat(72)}\n${name} ${pkg.version} — ${pkg.license}\n${url}\n\n`;
  if (sameAs) { out += `Same license as ${sameAs} above.\n\n`; continue; }
  const file = ['LICENSE', 'LICENSE.md', 'LICENSE.txt'].map((f) => join(dir, f)).find(existsSync);
  out += `${(file ? readFileSync(file, 'utf8') : inlineLicense).trim()}\n\n`;
}
writeFileSync(join(root, 'public', 'THIRD_PARTY_NOTICES.txt'), out);
console.log('public/THIRD_PARTY_NOTICES.txt written');
