// UI test (0.4.0): the Form tab as a conversation: scan → apply → scan again, one history entry, reopen.
import http from 'node:http';
import { launch } from './browser.mjs';
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', (d) => { body += d; });
  req.on('end', () => {
    res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') return res.end();
    if (req.url.endsWith('/page')) { res.setHeader('content-type', 'text/html'); return res.end('<html><head><title>Sign up</title></head><body><form><label>First name <input name="first"></label><label>Last name <input name="last"></label><label>Email <input name="email" type="email"></label></form></body></html>'); }
    const j = JSON.parse(body || '{}');
    if (!j.messages) { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ data: [{ id: 'fake' }] })); }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{}' } }], usage: { prompt_tokens: 100, completion_tokens: 5 } }));
  });
});
await new Promise((r) => server.listen(8769, r));
const base = 'http://127.0.0.1:8769';
const ctx = await launch();
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
const page = await ctx.newPage(); await page.goto(`${base}/page`);
const panel = await ctx.newPage(); panel.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
await panel.goto(`chrome-extension://${sw.url().split('/')[2]}/sidepanel.html`);
await panel.evaluate(async (b) => chrome.storage.local.set({ apiModels: [{ id: 'api:fake', name: 'Fake', baseUrl: `${b}/v1`, apiKey: 'x', model: 'fake' }], model: 'api:fake',
  profile: 'First name: Anna\nLast name: Schmidt\nEmail: anna.schmidt@example.com' }), base);
await panel.reload(); await page.bringToFront(); await panel.waitForTimeout(1500);

let fails = 0; const ok = (c, m, extra = '') => { console.log(c ? 'PASS' : 'FAIL', m, c ? '' : extra); if (!c) fails++; };
const out = () => panel.$eval('#output', (e) => e.textContent);
const idle = async (re) => { for (let i = 0; i < 50; i++) { const s = await panel.evaluate(() => ({ out: document.querySelector('#output').textContent, idle: document.querySelector('#stop').classList.contains('hidden') })); if (s.idle && (!re || re.test(s.out))) return s.out; await panel.waitForTimeout(300); } return out(); };
const conv = () => panel.evaluate(() => { const p = document.querySelector('.panel[data-panel="form"]'); return {
  q: p.querySelector('[data-conv="q"]').textContent, earlier: p.querySelectorAll('[data-conv="list"] > .turn').length,
  scanLabel: document.querySelector('#prepareFill').textContent, refine: !document.querySelector('#refineFill').classList.contains('hidden'),
  preview: !document.querySelector('#fillPreview').classList.contains('hidden') }; });
const stored = async () => Object.values(await panel.evaluate(async () => chrome.storage.local.get(null))).flat().filter((e) => e && typeof e === 'object' && e.type === 'form' && Array.isArray(e.turns));

await panel.click('.tabs button[data-tab="form"]');
await panel.click('#prepareFill');
const o1 = await idle(/Prepared|none matched|No fillable/);
let c = await conv();
ok(/Prepared 3 of 3/.test(o1) && c.preview, 'scan prepares 3 values', o1);
ok(c.q === 'Fill the form' && c.scanLabel === 'Scan form again' && c.refine, 'turn shown; buttons switch to follow-up mode', JSON.stringify(c));
await panel.click('#applyFill');
const o2 = await idle(/Applied/);
ok(/Applied 3 value/.test(o2), 'apply', o2);
ok(await page.$eval('input[name=email]', (e) => e.value) === 'anna.schmidt@example.com', 'values entered on the page');
c = await conv();
ok(c.q === 'Apply the selected values' && c.earlier === 1 && !c.refine, 'apply is a turn; no prepared values left', JSON.stringify(c));
await panel.click('#prepareFill');
await idle(/Prepared/);
c = await conv();
ok(c.q === 'Scan the form again' && c.earlier === 2, 'scan again continues the conversation', JSON.stringify(c));
let f = await stored();
ok(f.length === 1 && f[0].turns.length === 3, 'one history entry with 3 turns', JSON.stringify(f.map((e) => e.turns.map((t) => t.question))));

await panel.click('#clear');
c = await conv();
ok(c.earlier === 0 && !c.q && c.scanLabel === 'Scan form & prepare values' && !c.preview, 'New resets the Form tab', JSON.stringify(c));
await panel.click('#historyBox > summary'); await panel.waitForTimeout(300);
const titles = await panel.$$eval('#historyList .entry-title', (b) => b.map((x) => x.textContent));
await (await panel.$$('#historyList .entry-title'))[titles.findIndex((t) => /Form/.test(t))].click(); await panel.waitForTimeout(400);
c = await conv();
ok(c.earlier === 2 && c.q === 'Scan the form again', 'reopened from the history', JSON.stringify({ c, titles }));

await ctx.close(); server.close();
console.log(fails ? `${fails} failed` : 'all passed');
