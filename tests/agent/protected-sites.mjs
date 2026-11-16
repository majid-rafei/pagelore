// Protected sites: which hosts match; the agent does not open them, and a page it may not read ends with
// a clear tool error instead of a retry.
import { setApiModels, bindModel } from '../../src/llm.js';
import { runAgent } from '../../src/features/agent.js';
import { protectedSite, setUserProtected, cleanDomain, ProtectedSiteError } from '../../src/protected-sites.js';
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) process.exitCode = 1; };

// 1. Matching.
const is = (url) => protectedSite(url)?.name || null;
ok(is('https://www.linkedin.com/jobs/view/1') === 'LinkedIn', 'linkedin.com and its subdomains');
ok(is('https://de.linkedin.com/in/anna') === 'LinkedIn', 'a country subdomain of LinkedIn');
ok(is('https://www.amazon.de/dp/1') === 'Amazon' && is('https://www.amazon.co.uk/') === 'Amazon' && is('https://amazon.com') === 'Amazon', 'amazon.* under country domains');
ok(is('https://uk.indeed.com/') === 'Indeed' && is('https://www.glassdoor.co.uk/') === 'Glassdoor', 'indeed and glassdoor variants');
ok(is('https://x.com/home') === 'X (Twitter)' && is('https://mobile.twitter.com/') === 'X (Twitter)', 'x.com and twitter.com');
ok(!is('https://notlinkedin.com/') && !is('https://linkedin.com.example.org/') && !is('https://s3.amazonaws.com/x') && !is('https://amazon.example.com/'), 'look-alike hosts are not matched');
ok(!is('https://www.example.com/') && !is('chrome://newtab/') && !is('not a url'), 'other pages are not matched');
ok(cleanDomain(' https://WWW.Shop.Example/x?y ') === 'shop.example' && cleanDomain('*.foo.org') === 'foo.org' && cleanDomain('nonsense') === '', 'user entries are cleaned');
setUserProtected(['shop.example', 'bad entry']);
ok(is('https://a.shop.example/p') === 'shop.example' && protectedSite('https://shop.example/').builtIn === false, 'a user domain covers its subdomains');
ok(!is('https://othershop.example/'), 'and not other domains');

// 2. The agent: open_url on a protected site is refused without navigating; a page it may not read gives a tool error.
let n = 0; const reqs = [];
const call = (name, args) => ({ id: `c${n}_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const script = [[call('open_url', { url: 'https://www.linkedin.com/jobs/view/1' })], [call('read_page', {})], [call('finish', { answer: 'Please copy the job text into the chat.' })]];
globalThis.fetch = async (url, opts = {}) => {
  reqs.push(JSON.parse(opts.body || '{}').messages);
  const calls = script[n++] || [call('finish', { answer: 'done' })];
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '', tool_calls: calls } }] }), { status: 200 });
};
setApiModels([{ id: 'api:fake', name: 'fake', baseUrl: 'https://fake.example/v1', apiKey: 'x', model: 'fake' }]);
const controller = new AbortController(); bindModel(controller.signal, 'api:fake');
const opened = [];
const browser = { site: 'example.com', url: async () => 'https://www.example.com/', canLeaveSite: async () => true,
  navigate: async (u) => { opened.push(u); },
  extract: async () => { throw new ProtectedSiteError({ name: 'LinkedIn', builtIn: true }); },
  snapshot: async () => ({ title: 'P', url: 'x', scroll: { y: 0, max: 0 }, elements: [], text: '' }), perform: async () => ({ ok: true }) };
const ui = { confirm: async () => 'run', ask: async () => '', takeMessages: () => [] };
const res = await runAgent({ goal: 'Summarize this job ad', browser, ui, signal: controller.signal, onEvent: () => {}, maxSteps: 10 });
const tools = reqs.at(-1).filter((m) => m.role === 'tool').map((m) => m.content);
ok(!opened.length && /LinkedIn does not allow extensions/.test(tools[0]) && /Do not try to open LinkedIn again/.test(tools[0]), 'open_url to LinkedIn: refused, not opened');
ok(/Do not read, click or open anything on LinkedIn/.test(tools[1] || ''), 'a protected page read: a tool error that says not to retry');
ok(/copy the job text/.test(res.answer || ''), 'the agent finishes');
