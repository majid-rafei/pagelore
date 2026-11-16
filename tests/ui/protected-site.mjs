// UI test: on a protected site (here one the user added) the panel warns, nothing reads the page
// (Summarize, the Chat agent), and the agent gets a tool error instead.
import http from 'node:http';
import { launch } from './browser.mjs';
let n = 0, pageLoads = 0; const asked = [];
const call = (name, args) => ({ id: `c${n}_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', (d) => { body += d; });
  req.on('end', () => {
    res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') return res.end();
    if (req.url.endsWith('/page')) { pageLoads++; res.setHeader('content-type', 'text/html'); return res.end('<html><head><title>Jobs</title></head><body><p>Senior engineer, Berlin.</p></body></html>'); }
    const j = JSON.parse(body || '{}');
    if (!j.messages) { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ data: [{ id: 'fake' }] })); }
    n++; asked.push(JSON.stringify(j.messages));
    const tool_calls = n === 1 ? [call('read_page', {})] : [call('finish', { answer: 'I may not read this site: please paste the job text.' })];
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls } }], usage: { prompt_tokens: 100, completion_tokens: 5 } }));
  });
});
await new Promise((r) => server.listen(8772, r));
const base = 'http://127.0.0.1:8772';
const ctx = await launch({ args: ['--host-resolver-rules=MAP jobs.shop.test 127.0.0.1'] });
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
const panel = await ctx.newPage(); panel.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
await panel.goto(`chrome-extension://${sw.url().split('/')[2]}/sidepanel.html`);
await panel.evaluate(async (b) => chrome.storage.local.set({ apiModels: [{ id: 'api:fake', name: 'Fake', baseUrl: `${b}/v1`, apiKey: 'x', model: 'fake' }], model: 'api:fake' }), base);
let fails = 0; const ok = (c, m, extra = '') => { console.log(c ? 'PASS' : 'FAIL', m, c ? '' : extra); if (!c) fails++; };

// The user adds the domain in the settings.
await panel.click('#openSettings');
ok(/LinkedIn/.test(await panel.$eval('#builtInProtected', (e) => e.textContent)), 'Settings list the built-in sites');
await panel.fill('#protectedSites', 'https://www.shop.test/jobs\nnot a domain');
await panel.dispatchEvent('#protectedSites', 'change');
ok(await panel.$eval('#protectedSites', (e) => e.value) === 'shop.test', 'the entry is cleaned to its domain');
ok(JSON.stringify((await panel.evaluate(() => chrome.storage.local.get('protectedSites'))).protectedSites) === '["shop.test"]', 'and saved');
await panel.click('#closeSettings');

const page = await ctx.newPage(); await page.goto('http://jobs.shop.test:8772/page');
await page.bringToFront(); await panel.waitForTimeout(1500);
const banner = await panel.$eval('#protectedBanner', (e) => (e.classList.contains('hidden') ? '' : e.textContent));
ok(/shop\.test is in your protected sites/.test(banner), 'the panel warns on the protected site', banner);

await panel.click('.tabs button[data-tab="summarize"]'); await panel.click('#summarize');
let out = '';
for (let i = 0; i < 20; i++) { out = await panel.$eval('#output', (e) => e.textContent); if (/Error|Summary/i.test(out)) break; await panel.waitForTimeout(250); }
ok(/does not read or act on this page/.test(out) && n === 0, 'Summarize: refused, nothing sent to the model', out.slice(0, 200));

await panel.click('.tabs button[data-tab="chat"]');
await panel.fill('#goal', 'Summarize this job ad'); await panel.click('#runTask');
for (let i = 0; i < 40; i++) { out = await panel.$eval('#output', (e) => e.textContent); if (/paste the job text|Error/.test(out)) break; await panel.waitForTimeout(300); }
ok(/paste the job text/.test(out), 'Chat: the message is answered', out.slice(0, 200));
ok(!/Senior engineer/.test(asked.join('')), 'no page text reached the model');
ok(/Do not read, click or open anything on shop\.test/.test(asked[1] || ''), 'the agent got the protected-site tool error');
ok(pageLoads === 1, `the page was not reloaded (${pageLoads} loads)`);
await ctx.close(); server.close();
console.log(fails ? `${fails} failed` : 'all passed');
