// Opening another site: the question names the site the tab is on now (not the start site); "Run" allows
// that site for the rest of the request, "Allow for this request" allows all sites; "Skip" declines.
import { setApiModels, bindModel } from '../../src/llm.js';
import { runAgent } from '../../src/features/agent.js';
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) process.exitCode = 1; };
let n = 0, script = [];
const call = (name, args) => ({ id: `c${n}_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const open = (url) => [call('open_url', { url })];
globalThis.fetch = async () => {
  const calls = script[n++] || [call('finish', { answer: 'done' })];
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '', tool_calls: calls } }] }), { status: 200 });
};
setApiModels([{ id: 'api:fake', name: 'fake', baseUrl: 'https://fake.example/v1', apiKey: 'x', model: 'fake' }]);
const controller = new AbortController(); bindModel(controller.signal, 'api:fake');
let here = 'https://www.shop.example/start';
const opened = [];
const browser = { site: 'shop.example', url: async () => here, canLeaveSite: async () => true,
  navigate: async (u) => { here = u; opened.push(u); },
  extract: async () => ({ title: 'P', url: here, blocks: [{ text: 'x' }] }),
  snapshot: async () => ({ title: 'P', url: here, scroll: { y: 0, max: 0 }, elements: [], text: 'x' }), perform: async () => ({ ok: true }) };
const asked = []; let answers = [];
const ui = { confirm: async ({ text }) => { asked.push(text); return answers.shift() || 'skip'; }, ask: async () => '', takeMessages: () => [] };
const events = [];
const run = () => runAgent({ goal: 'Compare prices', browser, ui, signal: controller.signal, onEvent: (e) => { if (e.type === 'step') events.push(e.text); }, maxSteps: 12 });

// 1. Run for google, then from google to bol.com with "Allow for this request", then otto.de without asking.
n = 0; answers = ['run', 'all'];
script = [open('https://www.google.com/search?q=laptop'), open('https://www.google.com/search?q=laptop+2'), open('https://www.bol.com/p/1'),
  open('https://www.otto.de/p/2'), open('https://www.google.com/x'), [call('finish', { answer: 'done' })]];
await run();
ok(asked[0] === 'Leave shop.example and open https://www.google.com/search?q=laptop', `first question names the start site (${asked[0]})`);
ok(asked[1] === 'Leave google.com and open https://www.bol.com/p/1', `second question names the site open now, not the start site (${asked[1]})`);
ok(asked.length === 2, `"Run" allowed google.com for the request; "Allow for this request" allowed the rest (${asked.length} questions)`);
ok(opened.length === 5 && opened.includes('https://www.otto.de/p/2'), `all five pages opened (${opened.length})`);
ok(events.some((e) => /allowed opening other sites/.test(e)), 'the allow-all choice is shown in the steps');

// 2. A new request asks again; "Skip" declines and nothing opens.
n = 0; answers = ['skip']; asked.length = 0; opened.length = 0; here = 'https://www.otto.de/p/2';
script = [open('https://www.zalando.de/'), [call('finish', { answer: 'done' })]];
await run();
ok(asked[0] === 'Leave otto.de and open https://www.zalando.de/' && !opened.length, `a new request asks again; Skip declines (${asked[0]})`);
// 3. The site the tab is on now opens without a question.
n = 0; answers = []; asked.length = 0;
script = [open('https://www.otto.de/p/3'), [call('finish', { answer: 'done' })]];
await run();
ok(!asked.length && opened.at(-1) === 'https://www.otto.de/p/3', 'a page of the current site: no question');
