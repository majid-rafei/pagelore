// UI test: the panel is reloaded while the agent works; the chat is in the history with its progress and continues.
import http from 'node:http';
import { launch } from './browser.mjs';
let n = 0; const asked = [];
const call = (name, args) => ({ id: `c${n}_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', (d) => { body += d; });
  req.on('end', () => {
    res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') return res.end();
    if (req.url.endsWith('/page')) { res.setHeader('content-type', 'text/html'); return res.end('<html><head><title>Shop</title></head><body><p>Aurora 14 is quiet.</p></body></html>'); }
    const j = JSON.parse(body || '{}');
    if (!j.messages) { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ data: [{ id: 'fake' }] })); }
    n++; asked.push(JSON.stringify(j.messages));
    let tool_calls;
    if (asked.at(-1).includes('Follow-up from the user')) tool_calls = [call('finish', { answer: 'Continued: Aurora 14 is the quiet one.' })];
    else if (n === 1) tool_calls = [call('update_plan', { steps: [{ title: 'Read the page', status: 'in_progress' }, { title: 'Compare', status: 'pending' }] })];
    else if (n === 2) tool_calls = [call('write_notes', { text: 'Aurora 14 is quiet (noted before the reload)' })];
    else return; // never answers: the panel is reloaded meanwhile
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls } }], usage: { prompt_tokens: 100, completion_tokens: 5 } }));
  });
});
await new Promise((r) => server.listen(8770, r));
const base = 'http://127.0.0.1:8770';
const ctx = await launch();
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
const page = await ctx.newPage(); await page.goto(`${base}/page`);
const panel = await ctx.newPage(); panel.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
await panel.goto(`chrome-extension://${sw.url().split('/')[2]}/sidepanel.html`);
await panel.evaluate(async (b) => chrome.storage.local.set({ apiModels: [{ id: 'api:fake', name: 'Fake', baseUrl: `${b}/v1`, apiKey: 'x', model: 'fake' }], model: 'api:fake' }), base);
await panel.reload(); await page.bringToFront(); await panel.waitForTimeout(1500);
let fails = 0; const ok = (c, m, extra = '') => { console.log(c ? 'PASS' : 'FAIL', m, c ? '' : extra); if (!c) fails++; };
const chats = async () => Object.values(await panel.evaluate(async () => chrome.storage.local.get(null))).flat().filter((e) => e && typeof e === 'object' && e.type === 'chat' && Array.isArray(e.turns));

await panel.fill('#goal', 'Which laptop is quiet?'); await panel.click('#runTask');
for (let i = 0; i < 40 && n < 3; i++) await panel.waitForTimeout(250);
await panel.waitForTimeout(500);
let c = await chats();
ok(c.length === 1 && c[0].memory?.interrupted && c[0].memory.state.notes.some((x) => /before the reload/.test(x)), 'progress saved while working', JSON.stringify(c.map((e) => e.memory?.state)));
await panel.reload(); await panel.waitForTimeout(1500);
c = await chats();
ok(c.length === 1 && /stopped before it finished/.test(c[0].turns.at(-1).answer), 'after the reload the chat is in the history, marked as stopped', JSON.stringify(c.map((e) => e.turns)));
await panel.click('#historyBox > summary'); await panel.waitForTimeout(300);
const titles = await panel.$$eval('#historyList .entry-title', (b) => b.map((x) => x.textContent));
await (await panel.$$('#historyList .entry-title'))[titles.findIndex((t) => /quiet/.test(t))].click(); await panel.waitForTimeout(500);
const notes = await panel.$eval('#agentNotes', (e) => e.textContent).catch(() => '');
ok(/before the reload/.test(notes), 'reopened: notes are back', notes);
await panel.fill('#goal', 'continue'); await panel.click('#runTask');
let out = '';
for (let i = 0; i < 40; i++) { out = await panel.$eval('#output', (e) => e.textContent); if (/Continued/.test(out)) break; await panel.waitForTimeout(300); }
ok(/Continued/.test(out), 'continues', out);
ok(/before the reload/.test(asked.at(-1)) && /stopped here/.test(asked.at(-1)), 'the continuation request has the notes and the stop note');
await panel.waitForTimeout(500);
c = await chats();
ok(c.length === 1 && c[0].turns.length === 2 && !c[0].memory.interrupted && /Continued/.test(c[0].turns.at(-1).answer), 'one entry, 2 turns, finished', JSON.stringify(c.map((e) => e.turns.map((t) => t.answer))));
await ctx.close(); server.close();
console.log(fails ? `${fails} failed` : 'all passed');
