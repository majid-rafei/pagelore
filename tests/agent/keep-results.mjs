// Tool results stay in full; over the limit the oldest are shortened first (no extra request), then summarized;
// a repeated unchanged read points back; a follow-up keeps the earlier results; checkpoints.
import { setApiModels, bindModel } from '../../src/llm.js';
import { runAgent } from '../../src/features/agent.js';
let n = 0, script = [], reqs = [], compactions = 0;
const call = (name, args) => ({ id: `c${n}_${name}_${Math.random().toString(36).slice(2, 6)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
globalThis.fetch = async (url, opts = {}) => {
  n++;
  const body = JSON.parse(opts.body || '{}');
  if (/compact the memory/.test(body.messages[0].content)) { compactions++; return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'SUMMARY:\nEarlier: read pages.\nNOTES:\n- page 1 says A' } }] }), { status: 200 }); }
  reqs.push(body.messages);
  const next = script.shift() || { calls: [call('finish', { answer: 'done' })] };
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '', tool_calls: next.calls } }] }), { status: 200 });
};
setApiModels([{ id: 'api:fake', name: 'fake', baseUrl: 'https://fake.example/v1', apiKey: 'x', model: 'fake' }]);
const controller = new AbortController(); bindModel(controller.signal, 'api:fake');
let here = 'https://example.com/p0', version = 1;
const words = (k) => Array.from({ length: 60 }, (_, i) => `Page ${k} line ${i}: some text about item ${k}-${i} version ${version}.`);
const browser = { site: 'example.com', url: async () => here, canLeaveSite: async () => false, navigate: async (u) => { here = u; },
  extract: async () => ({ title: `Page ${here.slice(-1)}`, url: here, blocks: words(here.slice(-1)).map((text) => ({ text })) }),
  snapshot: async () => ({ title: 'P', url: here, scroll: { y: 0, max: 0 }, elements: [], text: 'x' }), perform: async () => ({ ok: true }) };
const ui = { confirm: async () => 'run', ask: async () => '', takeMessages: () => [] };
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) process.exitCode = 1; };
const events = [], checkpoints = [];
const onEvent = (e) => { if (e.type === 'checkpoint') checkpoints.push(e.memory); if (e.type === 'step') events.push(e.text); };
const full = (msgs) => msgs.filter((m) => m.role === 'tool' && m.content.length > 1500).length;
const removed = (msgs) => msgs.filter((m) => m.role === 'tool' && /full result removed/.test(m.content)).length;

// 1. Read 3 pages below the limit: all stay in full.
script = [{ calls: [call('update_plan', { steps: [{ title: 'Read', status: 'in_progress' }] }), call('read_page', {})] },
  { calls: [call('open_url', { url: 'https://example.com/p1' }), call('read_page', {})] },
  { calls: [call('open_url', { url: 'https://example.com/p2' }), call('read_page', {})] },
  // 2. Back to page 0 and read it again, unchanged: a pointer, not the text again.
  { calls: [call('open_url', { url: 'https://example.com/p0' }), call('read_page', {})] },
  { calls: [call('finish', { answer: 'Read 3 pages.' })] }];
const r1 = await runAgent({ goal: 'Read pages', browser, ui, signal: controller.signal, onEvent, compactAt: 100000, maxSteps: 25 });
let last = reqs.at(-1);
ok(full(last) === 3 && removed(last) === 0, `below the limit: all 3 page reads in full (${full(last)})`);
const back = last.filter((m) => m.role === 'tool').at(-1).content;
ok(/Same result as at step 1/.test(back) && back.length < 300, `unchanged page read again → pointer (${back.slice(0, 60)})`);
ok(checkpoints.length === 4 && checkpoints.at(-1).interrupted, `checkpoint after every step (${checkpoints.length})`);
ok(!JSON.stringify(r1.memory.transcript).includes('stopped here'), 'checkpoints do not change the live transcript');
// The start of each request is the start of the one after it (cacheable): no message changed in place.
const same = reqs.slice(1).every((r, i) => JSON.stringify(r.slice(0, reqs[i].length - 1)) === JSON.stringify(reqs[i].slice(0, -1)));
ok(same, 'each request starts with the previous one, unchanged (cache)');

// 3. A changed page read again: in full.
reqs = []; version = 2;
script = [{ calls: [call('read_page', {})] }, { calls: [call('finish', { answer: 'ok' })] }];
const r2 = await runAgent({ goal: 'x', browser, ui, signal: controller.signal, onEvent, compactAt: 100000, memory: r1.memory, followUp: 'read it again' });
last = reqs.at(-1);
ok(last.filter((m) => m.role === 'tool').at(-1).content.length > 1500, 'changed page: read in full');
ok(full(reqs[0]) === 3 && compactions === 0, 'follow-up below the limit: earlier reads still in full, no extra request');

// 4. Over the limit: the oldest are shortened (no extra request), the last step stays in full.
reqs = []; events.length = 0; version = 3;
script = [5, 6, 7, 8].map((k) => ({ calls: [call('open_url', { url: `https://example.com/p${k}` }), call('read_page', {})] }));
await runAgent({ goal: 'x', browser, ui, signal: controller.signal, onEvent, compactAt: 8000, memory: r2.memory, followUp: 'read 4 more' });
const sizes = reqs.map((r) => JSON.stringify(r).length);
console.log('  request sizes:', sizes.join(', '), '| events:', events.filter((e) => /Compacted/.test(e)).join(' / '));
ok(events.some((e) => /Compacted its memory \(shortened \d+ long earlier results?\)/.test(e)) && compactions === 0, 'shortened without an extra request');
last = reqs.at(-1);
ok(removed(last) >= 1 && full(last) >= 1, `oldest removed (${removed(last)}), newest in full (${full(last)})`);
ok(/full result removed/.test(last.filter((m) => m.role === 'tool' && m.content.length < 1500 && /read_page/.test(m.content))[0]?.content || ''), 'shortened result names the call');
ok(Math.max(...sizes) * 0.3 < 8000 * 1.6, 'requests stay near the limit');
const trims = events.filter((e) => /Compacted/.test(e)).length;
ok(trims <= 2, `shortening happens rarely (${trims} times in ${reqs.length} requests)`);

// 5. Still too large after shortening (long notes): one summary request.
reqs = []; events.length = 0;
script = Array.from({ length: 18 }, (_, i) => ({ calls: [call('write_notes', { text: `Note ${i}: ${'long note text '.repeat(250)}` })] }));
await runAgent({ goal: 'x', browser, ui, signal: controller.signal, onEvent, compactAt: 8000, memory: r2.memory, followUp: 'write notes' });
ok(compactions >= 1 && events.some((e) => /summarized the older conversation/.test(e)), `then summarized (${compactions} extra request)`);
