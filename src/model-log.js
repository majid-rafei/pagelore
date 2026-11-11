// The model log as a readable text file, one file per question and answer. Every request is written
// in full, exactly as it was sent: a page shown to the model for one step is in that request and
// gone from the next one, as it was. Then the reply exactly as it came back. Before each request, a
// line says how much of it starts the same as the request before: servers cache only that part
// (token by token), so the first difference is where the full price starts.

const num = (n) => Number(n || 0).toLocaleString('en');
const asText = (content) => (typeof content === 'string' ? content : JSON.stringify(content ?? ''));

/** The request of a call: the body as sent, or the messages (a request that failed before it was sent). */
function bodyOf(c) {
  if (c.request) { try { return JSON.parse(c.request); } catch { /* written raw below */ } }
  return { messages: c.messages || [] };
}

/**
 * The prompt of a request in the order a server reads it (tools, then each message), as pieces,
 * so the first difference between two requests can be named ("message 3 (user), character 120").
 */
function promptParts(body) {
  const parts = [];
  if (body.tools) parts.push({ name: 'tool definitions', text: JSON.stringify(body.tools) });
  (body.messages || []).forEach((m, i) => {
    parts.push({ name: `message ${i + 1} (${m.role})`, text: `${m.role}\n${asText(m.content)}${m.tool_calls ? `\n${JSON.stringify(m.tool_calls)}` : ''}${m.tool_call_id ? `\n${m.tool_call_id}` : ''}` });
  });
  return parts;
}

/** How much of `body` starts the same as `prev`, and where it first differs. */
function samePrefix(prev, body) {
  const a = promptParts(prev), b = promptParts(body);
  const total = b.reduce((n, p) => n + p.text.length, 0);
  let same = 0;
  for (let i = 0; i < b.length; i++) {
    const x = a[i]?.text ?? '', y = b[i].text;
    if (a[i] && x === y && a[i].name === b[i].name) { same += y.length; continue; }
    let k = 0;
    while (k < x.length && k < y.length && x[k] === y[k]) k++;
    same += k;
    // The memory message has "--- Section ---" headings: name the one the difference is in.
    const heading = [...y.slice(0, k).matchAll(/^--- (.+?) ---$/gm)].at(-1)?.[1];
    const what = !a[i] ? `${b[i].name} is new` : `${b[i].name}, character ${num(k)} of ${num(y.length)}${heading ? ` (in "${heading}")` : ''}`;
    const was = x.slice(k, k + 80).replace(/\s+/g, ' '), now = y.slice(k, k + 80).replace(/\s+/g, ' ');
    return { same, total, where: what, detail: a[i] ? `before: «${was}»\n   now:    «${now}»` : '' };
  }
  return { same, total, where: a.length > b.length ? `${a.length - b.length} message(s) at the end were removed` : 'nothing (the same request)', detail: '' };
}

function usageLine(u) {
  if (!u) return '';
  return `in ${num(u.input)} tokens${u.input ? ` (cached ${num(u.cached)}, ${Math.round((100 * (u.cached || 0)) / u.input)}%)` : ''}, out ${num(u.output)}`;
}

function formatMessage(m, i) {
  const facts = [`message ${i + 1}`, m.role, m.tool_call_id && `tool_call_id=${m.tool_call_id}`, `${num(asText(m.content).length)} characters`].filter(Boolean);
  const out = [`---------- ${facts.join(' · ')} ----------`, asText(m.content)];
  if (m.tool_calls) out.push(`tool_calls: ${JSON.stringify(m.tool_calls, null, 2)}`);
  const rest = Object.fromEntries(Object.entries(m).filter(([k]) => !['role', 'content', 'tool_calls', 'tool_call_id'].includes(k)));
  if (Object.keys(rest).length) out.push(`other fields: ${JSON.stringify(rest)}`);
  return out.join('\n');
}

/**
 * @param {object[]} calls  the onModelCall entries (llm.js) of one question and its answer
 * @param {{title?: string, url?: string, question?: string, number?: number, before?: object}} info
 *   before: the last request of the previous question (the first request is compared with it)
 */
export function formatModelLog(calls, { title = '', url = '', question = '', number = 0, before = null } = {}) {
  const time = (t) => new Date(t).toLocaleTimeString();
  const usage = calls.reduce((s, c) => ({ input: s.input + (c.usage?.input || 0), cached: s.cached + (c.usage?.cached || 0), output: s.output + (c.usage?.output || 0) }), { input: 0, cached: 0, output: 0 });
  const out = [
    `Model log${title ? ` · ${title}` : ''}`,
    ...(url ? [`Tab: ${url}`] : []),
    ...(number ? [`Question ${number} of this chat`] : []),
    ...(question ? [`Question: ${question}`] : []),
    `Saved: ${new Date().toLocaleString()} · ${calls.length} request${calls.length === 1 ? '' : 's'} · ${usageLine(usage)}`,
    '',
    'Each request is written in full, exactly as it was sent (the "messages" of the request body, then its other fields),',
    'and the reply exactly as it came back. "Same start" is the part of the request that is the same as in the request',
    'before it, in the order the server reads it (tool definitions, then the messages). Servers cache only that part;',
    'everything after the first difference is new input and paid in full.',
  ];
  let prev = before ? bodyOf(before) : null;
  let toolsSeen = null; // [json, request number]: the tool definitions are long, so they are written when they change
  calls.forEach((c, i) => {
    const body = bodyOf(c);
    const facts = [time(c.time), c.model, `${((c.ms || 0) / 1000).toFixed(1)} s`, usageLine(c.usage)].filter(Boolean);
    out.push('', `==================== Request ${i + 1} of ${calls.length} · ${facts.join(' · ')} ====================`);
    if (prev) {
      const p = samePrefix(prev, body);
      out.push(`Same start as the ${i ? 'request before' : 'last request of the previous question'}: ${num(p.same)} of ${num(p.total)} characters (${p.total ? Math.round((100 * p.same) / p.total) : 0}%). First difference: ${p.where}`);
      if (p.detail) out.push(`   ${p.detail}`);
    } else out.push('First request: nothing to compare with.');
    if (!c.request && c.messages) out.push('(A request that failed before it was sent: the messages as given to the model.)');
    const { messages = [], tools, ...params } = body;
    out.push(`Request fields: ${JSON.stringify(params)}`);
    if (tools) {
      const json = JSON.stringify(tools);
      if (toolsSeen?.[0] === json) out.push(`tools: the same ${tools.length} definitions as in request ${toolsSeen[1]} (${num(json.length)} characters)`);
      else { out.push(`tools (${tools.length} definitions): ${JSON.stringify(tools, null, 2)}`); toolsSeen = [json, i + 1]; }
    }
    messages.forEach((m, k) => out.push(formatMessage(m, k)));
    if (c.request) {
      try { JSON.parse(c.request); } catch { out.push(`(The body was not valid JSON, as sent:)\n${c.request}`); }
    }
    out.push('', '◀◀◀◀◀◀◀◀◀◀ REPLY');
    if (c.error) out.push(`Error: ${c.error}`);
    if (c.response) out.push(JSON.stringify(c.response, null, 2));
    else if (!c.error) {
      if (c.reply) out.push(c.reply);
      for (const t of c.toolCalls || []) out.push(`→ ${t.name} ${t.args || ''}`);
    }
    prev = body;
  });
  return `${out.join('\n')}\n`;
}
