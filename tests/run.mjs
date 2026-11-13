// Runs the tests of tests/agent (or tests/ui with `ui`) one after another; fails if any check fails.
// Each test prints "PASS …" / "FAIL …" lines. Usage: node tests/run.mjs [agent|ui] [name filter]
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const [kind = 'agent', filter = ''] = process.argv.slice(2);
const dir = new URL(`./${kind}/`, import.meta.url).pathname;
const files = readdirSync(dir).filter((f) => f.endsWith('.mjs') && f !== 'browser.mjs' && f.includes(filter)).sort();
let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, [`${dir}${f}`], { encoding: 'utf8', timeout: 180000 });
  const out = `${r.stdout}${r.stderr}`;
  const pass = (out.match(/^PASS/gm) || []).length;
  const fails = out.split('\n').filter((l) => /^FAIL|PAGE ERROR/.test(l));
  const ok = r.status === 0 && !fails.length && pass > 0;
  console.log(`${ok ? '✓' : '✗'} ${f}: ${pass} passed${fails.length ? `, ${fails.length} failed` : ''}${r.status ? ` (exit ${r.status ?? 'timeout'})` : ''}`);
  if (!ok) { failed++; console.log((fails.length ? fails.join('\n') : out.split('\n').slice(-15).join('\n')).replace(/^/gm, '    ')); }
}
console.log(failed ? `${failed} of ${files.length} test files failed` : `all ${files.length} test files passed`);
process.exitCode = failed ? 1 : 0;
