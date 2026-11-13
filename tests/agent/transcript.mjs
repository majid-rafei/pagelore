// Standard transcript: mid-run messages once, follow-up last, plain text at step 1 of a follow-up rejected,
// Save needs confirmation, "allow for this request", and 0.3.0 memory still works.
import { setApiModels, bindModel } from '../../src/llm.js';
import { runAgent } from '../../src/features/agent.js';
let n = 0, script = [], reqs = [];
const call = (name, args) => ({ id: `c${n}_${name}_${Math.random().toString(36).slice(2, 6)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
globalThis.fetch = async (url, opts = {}) => {
  n++;
  const body = JSON.parse(opts.body || '{}');
  reqs.push(body.messages);
  const next = script.shift() || { calls: [call('finish', { answer: 'done' })] };
  const msg = { role: 'assistant', content: next.text || '', ...(next.calls ? { tool_calls: next.calls } : {}) };
  return new Response(JSON.stringify({ choices: [{ message: msg }] }), { status: 200, headers: { 'content-type': 'application/json' } });
};
setApiModels([{ id: 'api:fake', name: 'fake', baseUrl: 'https://fake.example/v1', apiKey: 'x', model: 'fake' }]);
const controller = new AbortController();
bindModel(controller.signal, 'api:fake');
const els = [{ id: 5, tag: 'input', type: 'text', text: 'Skill', value: '' }, { id: 6, tag: 'button', type: 'button', text: 'Save' }];
const performed = [];
const browser = { site: 'example.com', url: async () => 'https://example.com/form', canLeaveSite: async () => false,
  snapshot: async () => ({ title: 'Form', url: 'https://example.com/form', scroll: { y: 0, max: 0 }, elements: els, text: 'PAGE TEXT '.repeat(50) }), perform: async (a) => { performed.push(a); return { ok: true, message: `${a.action} ${a.id}` }; } };
let inbox = [], confirms = [], decision = 'run';
const ui = { confirm: async (c) => { confirms.push(c); return decision; }, ask: async () => '', takeMessages: () => inbox.splice(0) };
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) process.exitCode = 1; };
const count = (msgs, s) => msgs.filter((m) => typeof m.content === 'string' && m.content.includes(s)).length;

// --- Run 1: fill the form; the user sends a message mid-run.
script = [
  { calls: [call('update_plan', { steps: [{ title: 'Fill skill', status: 'in_progress' }] }), call('find_elements', { query: 'skill' })] },
  { calls: [call('act', { action: 'type', id: 5, value: 'TypeScript' })] },
  { calls: [call('write_notes', { text: 'typed TypeScript into Skill' })] },
  { calls: [call('finish', { answer: 'I filled the form; please review it and save it yourself.' })] }
];
const onReq2 = () => { if (n === 2) inbox.push('Use C# too'); };
const origFetch = globalThis.fetch;
globalThis.fetch = async (...a) => { const r = await origFetch(...a); onReq2(); return r; };
const r1 = await runAgent({ goal: 'Fill the skills form, do not save', browser, ui, maxSteps: 10, signal: controller.signal, onEvent: () => {} });
let last = reqs.at(-1);
ok(count(last, 'Message from the user (sent while you worked): Use C# too') === 1, 'mid-run message appears once, in place');
ok(!last.some((m) => /newest wins/.test(m.content || '')), 'no "newest wins" list');
ok(last.some((m) => m.role === 'tool' && /\[6\] button/.test(m.content) && !/removed/.test(m.content)), 'element list kept in full (below the limit)');
const midIdx = last.findIndex((m) => (m.content || '').includes('Use C# too'));
ok(last[midIdx - 1]?.role === 'tool', 'mid-run message comes after tool results, not between a call and its result');
ok(r1.memory.transcript.at(-1).content.includes('I filled the form'), 'answer is the last transcript message');

// --- Run 2: follow-up; model first replies plain text (a recap) → must be nudged, then acts and clicks Save.
reqs = [];
script = [
  { text: 'Here is a recap: TypeScript is in the form, not saved. Sorry about About.' },
  { calls: [call('find_elements', { query: 'save' })] },
  { calls: [call('act', { action: 'click', id: 6 })] },
  { calls: [call('act', { action: 'click', id: 6 })] },
  { calls: [call('finish', { answer: 'Saved.' })] }
];
decision = 'all'; confirms = [];
const r2 = await runAgent({ goal: 'Fill the skills form, do not save', browser, ui, maxSteps: 10, signal: controller.signal, onEvent: () => {},
  memory: r1.memory, followUp: 'Add and save them yourself' });
const first = reqs[0];
ok(first.at(-2).content.includes('Follow-up from the user') && first.at(-2).content.includes('Add and save them yourself'), 'follow-up is the last message before the state');
ok(first.at(-1).content.startsWith('--- Current request') && first.at(-1).content.includes('Add and save them yourself'), 'state starts with the current request');
ok(/from your earlier work/.test(first.at(-1).content), 'old plan is labeled as earlier work');
ok(count(first, 'Use C# too') === 1, 'old mid-run message still once (history, not re-sent as a list)');
ok(r2.answer === 'Saved.', `plain-text recap at step 1 not taken as the answer (got: ${r2.answer.slice(0, 40)})`);
ok(/did this|called no tool/i.test(reqs[1].at(-1).content), 'nudge after plain text');
ok(confirms.length === 1 && confirms[0].risky, `Save asked once, as risky (asked ${confirms.length})`);
ok(performed.filter((p) => p.id === 6).length === 2, 'both clicks ran after "allow for this request"');

// --- Run 3: 0.3.0 memory (talk + log + userMessages).
reqs = [];
script = [{ calls: [call('finish', { answer: 'ok' })] }];
const oldMem = { goal: 'g', state: { plan: [], notes: ['old note'], results: [] }, log: ['Step 1:', '  - read_page'], userMessages: ['old complaint'], steps: 3, summary: '',
  talk: [{ role: 'assistant', content: 'first answer' }], urls: { seen: [], read: [] } };
await runAgent({ goal: 'g', browser, ui, maxSteps: 5, signal: controller.signal, onEvent: () => {}, memory: oldMem, followUp: 'next' });
ok(count(reqs[0], 'old note') >= 1 && count(reqs[0].slice(1), 'read_page') === 1 && count(reqs[0], 'first answer') === 1 && count(reqs[0], 'old complaint') === 0, '0.3.0 memory folded in (notes, log, talk; old messages not re-sent)');
console.log('--- run1 last tool msgs:'); for (const m of last.filter((m) => m.role === 'tool')) console.log(' ', m.content.slice(0, 150).replace(/\n/g, ' '));
console.log('--- run3 first req:'); for (const m of reqs[0]) console.log(' ', m.role, (m.content || '').slice(0, 200).replace(/\n/g, ' | '));
