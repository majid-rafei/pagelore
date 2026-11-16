// UI test: a chat message sent on the New Tab page (whose URL Chrome hides) is sent: no "Allow access" loop.
// With access to all sites the agent starts there and opens the pages it needs.
import http from 'node:http';
import { launch } from './browser.mjs';
let n = 0; const asked = [];
const call = (name, args) => ({ id: `c${n}_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const base = 'http://127.0.0.1:8771';
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', (d) => { body += d; });
  req.on('end', () => {
    res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') return res.end();
    if (req.url.endsWith('/page')) { res.setHeader('content-type', 'text/html'); return res.end('<html><head><title>Shop</title></head><body><p>Aurora 14 is quiet.</p></body></html>'); }
    const j = JSON.parse(body || '{}');
    if (!j.messages) { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ data: [{ id: 'fake' }] })); }
    n++; asked.push(JSON.stringify(j.messages));
    const tool_calls = n === 1 ? [call('open_url', { url: `${base}/page` })]
      : n === 2 ? [call('read_page', {})]
        : [call('finish', { answer: 'Aurora 14 is the quiet one.' })];
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls } }], usage: { prompt_tokens: 100, completion_tokens: 5 } }));
  });
});
await new Promise((r) => server.listen(8771, r));
const ctx = await launch();
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
const page = await ctx.newPage(); await page.goto('chrome://newtab/');
const panel = await ctx.newPage(); panel.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
await panel.goto(`chrome-extension://${sw.url().split('/')[2]}/sidepanel.html`);
await panel.evaluate(async (b) => chrome.storage.local.set({ apiModels: [{ id: 'api:fake', name: 'Fake', baseUrl: `${b}/v1`, apiKey: 'x', model: 'fake' }], model: 'api:fake' }), base);
await panel.reload(); await page.bringToFront(); await panel.waitForTimeout(1500);
let fails = 0; const ok = (c, m, extra = '') => { console.log(c ? 'PASS' : 'FAIL', m, c ? '' : extra); if (!c) fails++; };

const hidden = await panel.evaluate(async () => {
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return !t?.url;
}).catch(() => null);
console.log('  New Tab URL hidden from the extension:', hidden);

await panel.fill('#goal', 'Which laptop is quiet?'); await panel.click('#runTask');
let out = '';
for (let i = 0; i < 40; i++) { out = await panel.$eval('#output', (e) => e.textContent); if (/quiet one|Error/.test(out)) break; await panel.waitForTimeout(300); }
ok(/quiet one/.test(out), 'the message is sent and answered', out.slice(0, 300));
ok(await panel.$eval('#accessBanner', (e) => e.classList.contains('hidden')), 'no access banner');
ok(/tab shows no web page/.test(asked[0] || ''), 'the agent is told the tab shows no web page');
ok(/Aurora 14 is quiet/.test(asked[2] || ''), 'the agent opened and read the page');
ok(page.url() === `${base}/page`, `the tab now shows the page (${page.url()})`);
await ctx.close(); server.close();
console.log(fails ? `${fails} failed` : 'all passed');
