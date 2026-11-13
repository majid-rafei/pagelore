// Starts Chromium with the built extension (dist/). The tests' local web server must be reachable, so the
// test copy of the extension (tests/ui/.ext) is granted all hosts up front instead of asking for them.
// The browser: CHROME_PATH, or the Chromium of playwright-core (`npx playwright-core install chromium`).
import { cpSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const dist = new URL('../../dist/', import.meta.url).pathname;
const ext = new URL('./.ext/', import.meta.url).pathname;

export async function launch() {
  if (!existsSync(`${dist}manifest.json`)) throw new Error('dist/ is missing: run `npm run build` first.');
  cpSync(dist, ext, { recursive: true, force: true });
  const manifest = JSON.parse(readFileSync(`${ext}manifest.json`, 'utf8'));
  manifest.host_permissions = ['<all_urls>'];
  writeFileSync(`${ext}manifest.json`, JSON.stringify(manifest, null, 2));
  return chromium.launchPersistentContext('', {
    executablePath: process.env.CHROME_PATH || chromium.executablePath(), headless: true,
    args: ['--headless=new', `--disable-extensions-except=${ext}`, `--load-extension=${ext}`]
  });
}
