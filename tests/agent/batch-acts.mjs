// Several act calls in one reply: typing/selecting/checking run together; after a click, a combobox,
// a failure or a page message, the rest of the reply's acts are not run.
import { setApiModels, bindModel } from '../../src/llm.js';
import { runAgent } from '../../src/features/agent.js';
let n = 0; const reqs = [];
const call = (name, args) => ({ id: `c${n}_${Math.random().toString(36).slice(2, 7)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const t = (id, value) => call('act', { action: 'type', id, value });
const script = [
  [call('update_plan', { steps: [{ title: 'Fill', status: 'in_progress' }] }), call('find_elements', { what: 'form' })],
  [t(1, 'Anna'), t(2, 'Keller'), call('act', { action: 'select', id: 3, value: 'Germany' }), call('act', { action: 'check', id: 4 }), call('act', { action: 'click', id: 5 }), t(1, 'after click')],
  [t(6, 'TypeScript'), t(1, 'after combobox')],
  [t(99, 'missing'), t(2, 'after failure')],
  [t(7, 'bad value'), t(2, 'after message')],
  [call('finish', { answer: 'done' })]
];
globalThis.fetch = async (url, opts = {}) => {
  const body = JSON.parse(opts.body || '{}'); reqs.push(body.messages);
  const calls = script[n++] || [call('finish', { answer: 'done' })];
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '', tool_calls: calls } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
};
setApiModels([{ id: 'api:fake', name: 'fake', baseUrl: 'https://fake.example/v1', apiKey: 'x', model: 'fake' }]);
const controller = new AbortController(); bindModel(controller.signal, 'api:fake');
const els = [
  { id: 1, tag: 'input', type: 'text', text: 'First name', value: '', inViewport: true },
  { id: 2, tag: 'input', type: 'text', text: 'Last name', value: '', inViewport: true },
  { id: 3, tag: 'select', type: 'select-one', text: 'Country', options: ['Germany', 'France'], value: '', inViewport: true },
  { id: 4, tag: 'input', type: 'checkbox', text: 'Remote', checked: false, inViewport: true },
  { id: 5, tag: 'button', type: 'button', text: 'Add another', inViewport: true },
  { id: 6, tag: 'input', role: 'combobox', type: 'text', text: 'Skill', value: '', inViewport: true },
  { id: 7, tag: 'input', type: 'text', text: 'Email', value: '', inViewport: true }];
const done = [];
const browser = { site: 'example.com', url: async () => 'https://example.com/form', canLeaveSite: async () => false,
  snapshot: async () => ({ title: 'Form', url: 'https://example.com/form', scroll: { y: 0, max: 0 }, elements: els }),
  perform: async ({ action, id, value }) => { done.push(`${action} ${id} ${value ?? ''}`.trim());
    return id === 7 ? { ok: true, message: `typed “${value}” into “Email”`, messages: ['Enter a valid email'] } : { ok: true, message: `${action} ${id}` }; } };
const ui = { confirm: async () => 'run', ask: async () => '', takeMessages: () => [] };
const r = await runAgent({ goal: 'Fill the form', browser, ui, maxSteps: 10, signal: controller.signal, onEvent: () => {} });
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) process.exitCode = 1; };
console.log(done);
ok(done.slice(0, 5).join('|') === 'type 1 Anna|type 2 Keller|select 3 Germany|check 4|click 5', 'type, select, check and a click run in one reply');
ok(!done.includes('type 1 after click'), 'act after a click not run');
ok(done.includes('type 6 TypeScript') && !done.includes('type 1 after combobox'), 'act after typing into a combobox not run');
ok(!done.includes('type 2 after failure'), 'act after a failed act not run');
ok(done.includes('type 7 bad value') && !done.includes('type 2 after message'), 'act after a page message not run');
const tools = reqs.at(-1).filter((m) => m.role === 'tool').map((m) => m.content);
ok(tools.filter((x) => x.startsWith('Not done: the act before it')).length === 4, 'skipped acts tell the model to look again');
ok(r.steps <= 6, `steps used: ${r.steps}`);
