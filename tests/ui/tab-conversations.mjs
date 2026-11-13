// UI test (0.4.0): every tab is a conversation. Summarize + follow-up, Search, tab switching, New, reopen from history.
import http from 'node:http';
import { launch } from './browser.mjs';
const asked = [];
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', (d) => { body += d; });
  req.on('end', () => {
    res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') return res.end();
    if (req.url.endsWith('/page')) { res.setHeader('content-type', 'text/html'); return res.end('<html><head><title>Test shop</title></head><body><h1>Laptops</h1><p>The Aurora 14 is a quiet 14-inch laptop for 899 euros. The Breeze 14 costs 949 euros and its fan is loud.</p><p>Both have 16 GB RAM.</p></body></html>'); }
    const j = JSON.parse(body || '{}');
    if (!j.messages) { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ data: [{ id: 'fake' }] })); }
    const last = j.messages.at(-1).content;
    asked.push(last);
    const text = /The user now says: “shorter”/.test(last) ? 'Short: the Aurora 14 is quiet.' : 'Summary: two laptops; the Aurora 14 is quiet (899 euros), the Breeze 14 is loud (949 euros).';
    if (j.stream) {
      res.setHeader('content-type', 'text/event-stream');
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 300, completion_tokens: 20 } })}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }], usage: { prompt_tokens: 300, completion_tokens: 20 } }));
  });
});
await new Promise((r) => server.listen(8768, r));
const base = 'http://127.0.0.1:8768';
const ctx = await launch();
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
const page = await ctx.newPage(); await page.goto(`${base}/page`);
const panel = await ctx.newPage(); panel.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
await panel.goto(`chrome-extension://${sw.url().split('/')[2]}/sidepanel.html`);
await panel.evaluate(async (b) => chrome.storage.local.set({ apiModels: [{ id: 'api:fake', name: 'Fake', baseUrl: `${b}/v1`, apiKey: 'x', model: 'fake' }], model: 'api:fake' }), base);
await panel.reload(); await page.bringToFront(); await panel.waitForTimeout(1500);

let fails = 0; const ok = (c, m, extra = '') => { console.log(c ? 'PASS' : 'FAIL', m, c ? '' : extra); if (!c) fails++; };
const out = () => panel.$eval('#output', (e) => e.textContent);
const idle = async (re) => { for (let i = 0; i < 40; i++) { const s = await panel.evaluate(() => ({ out: document.querySelector('#output').textContent, idle: document.querySelector('#stop').classList.contains('hidden') })); if (s.idle && (!re || re.test(s.out))) return s.out; await panel.waitForTimeout(300); } return out(); };
const conv = (tab) => panel.evaluate((t) => { const p = document.querySelector(`.panel[data-panel="${t}"]`); return {
  q: p.querySelector('[data-conv="q"]').textContent, earlier: p.querySelectorAll('[data-conv="list"] > .turn').length,
  hasCard: !!p.querySelector('[data-conv="slot"] #assistantCard') }; }, tab);
const tab = (t) => panel.click(`.tabs button[data-tab="${t}"]`);
const stored = async (type) => Object.values(await panel.evaluate(async () => chrome.storage.local.get(null))).flat().filter((e) => e && typeof e === 'object' && e.type === type && Array.isArray(e.turns));

const chatOut = await out();
await tab('summarize');
ok((await conv('summarize')).hasCard, 'card moves into the Summarize tab');
await panel.click('#summarize');
const s1 = await idle(/Summary: two laptops/);
ok(/Summary: two laptops/.test(s1), 'summary written', s1);
let c = await conv('summarize');
ok(/Summary \(medium\) of/.test(c.q) && c.earlier === 0, 'question shown, no earlier turns', JSON.stringify(c));
await panel.fill('#summaryAsk', 'shorter'); await panel.press('#summaryAsk', 'Enter');
const s2 = await idle(/^Short:/);
ok(/^Short:/.test(s2), 'follow-up rewrites the summary', s2);
c = await conv('summarize');
ok(c.q === 'shorter' && c.earlier === 1, 'follow-up is a new turn; the first is folded', JSON.stringify(c));
ok(/Your last answer:[\s\S]*Summary: two laptops/.test(asked.at(-1)) && /Aurora/.test(asked.at(-1)), 'follow-up gets the last answer and page passages');

await tab('search');
ok(!/Short:/.test(await out()), 'Search tab shows its own output');
await panel.fill('#searchQuery', 'Breeze'); await panel.press('#searchQuery', 'Enter');
await idle(); c = await conv('search');
ok(c.q === 'Breeze', 'search query is the turn question', JSON.stringify(c));

await tab('summarize');
ok(/^Short:/.test(await out()), 'back in Summarize: its answer is still there');
await tab('chat');
ok((await out()) === chatOut, 'Chat tab keeps its own output');

let sum = await stored('summarize');
ok(sum.length === 1 && sum[0].turns.length === 2, 'one history entry for the summary conversation, 2 turns', JSON.stringify(sum.map((e) => e.turns.length)));

await tab('summarize'); await panel.click('#clear');
c = await conv('summarize');
ok(c.earlier === 0 && !c.q && (await out()) === 'Ready.', 'New clears the tab conversation', JSON.stringify(c));
await panel.click('#historyBox > summary'); await panel.waitForTimeout(300);
const titles = await panel.$$eval('#historyList .entry-title', (b) => b.map((x) => x.textContent));
const i = titles.findIndex((t) => /Summar/.test(t));
await (await panel.$$('#historyList .entry-title'))[i].click(); await panel.waitForTimeout(400);
c = await conv('summarize');
ok(c.q === 'shorter' && c.earlier === 1 && /^Short:/.test(await out()), 'reopened: turns and last answer back', JSON.stringify({ c, titles }));
await panel.fill('#summaryAsk', 'shorter'); await panel.press('#summaryAsk', 'Enter'); await idle(/^Short:/); await panel.waitForTimeout(300);
sum = await stored('summarize');
ok(sum.length === 1 && sum[0].turns.length === 3, 'a follow-up after reopening continues the same entry', JSON.stringify(sum.map((e) => e.turns.length)));

await ctx.close(); server.close();
console.log(fails ? `${fails} failed` : 'all passed');
