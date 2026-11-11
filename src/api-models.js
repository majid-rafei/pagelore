// Models served by an OpenAI-compatible API (OpenAI, OpenRouter, Requesty, Vultr, Ollama, LM Studio, …).
// The user adds them in Settings; they are stored in chrome.storage.local (never synced) and shared by
// every tab and window. Text sent to such a model goes to its server (on this computer for Ollama or LM Studio).

const STORE_KEY = 'apiModels';
export const API_PREFIX = 'api:';

/** @typedef {{ id: string, name: string, baseUrl: string, apiKey: string, model: string }} ApiModel */

/** @returns {Promise<ApiModel[]>} */
export async function loadApiModels() {
  try {
    const list = (await chrome.storage.local.get(STORE_KEY))[STORE_KEY];
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}
export const saveApiModels = (list) => chrome.storage.local.set({ [STORE_KEY]: list });

/** Calls fn(list) when the list changes (also when another window changed it). */
export function onApiModelsChange(fn) {
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[STORE_KEY]) fn(changes[STORE_KEY].newValue || []);
    });
  } catch { /* outside an extension page */ }
}

export const newApiModelId = () => `${API_PREFIX}${crypto.randomUUID().slice(0, 8)}`;

/** "https://host/v1/chat/completions/" → "https://host/v1". Throws on a URL that isn't http(s). */
export function normalizeBaseUrl(url) {
  const u = new URL(String(url || '').trim());
  if (!/^https?:$/.test(u.protocol)) throw new Error('The API URL must start with https:// (or http:// for a local server).');
  return u.href.replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/\/(chat\/completions|models)$/, '');
}
export const hostOf = (url) => { try { return new URL(url).host; } catch { return url; } };

/** True for a server on this computer or the local network (e.g. Ollama, LM Studio): no API bill. */
export function isLocalServer(url) {
  let h;
  try { h = new URL(url).hostname.replace(/^\[|\]$/g, ''); } catch { return false; }
  return h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h === '::1' || h === '0.0.0.0' ||
    /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
}

/**
 * Asks Chrome for access to the API's site, so requests work even when the server does not allow
 * browser requests (CORS). Must be called synchronously inside a click handler. Never throws.
 */
export function requestHostAccess(baseUrl) {
  try {
    const origin = new URL(baseUrl).origin;
    return chrome.permissions.request({ origins: [`${origin}/*`] }).catch(() => false);
  } catch { return Promise.resolve(false); }
}

async function call(cfg, path, init = {}) {
  const base = normalizeBaseUrl(cfg.baseUrl);
  let res;
  try {
    res = await fetch(`${base}${path}`, {
      ...init,
      headers: { ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}), 'Content-Type': 'application/json', ...init.headers }
    });
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    if (isLocalServer(base)) throw new Error(`Could not reach ${hostOf(base)}. Is the app running? Ollama: start it (or run “ollama serve”). ` +
      'LM Studio: start the server in its Developer tab. Then check the API URL.');
    throw new Error(`Could not reach ${hostOf(base)}. Check the API URL and your connection. ` +
      'A server that does not accept browser requests needs the site access Chrome asks for when you save the model.');
  }
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.text();
      try { const j = JSON.parse(body); detail = j?.error?.message || j?.message || j?.error || body; } catch { detail = body; }
    } catch { /* no body */ }
    detail = String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300);
    const hint = res.status === 401 || res.status === 403 ? ' Check the API key.'
      : res.status === 404 ? ' Check the API URL and the model name.'
        : res.status === 429 ? ' The server is rate-limiting requests or the account is out of credit.' : '';
    throw new Error(`${hostOf(base)} answered ${res.status}${detail ? `: ${detail}` : ''}.${hint}`);
  }
  return res;
}

/** Models offered by the server (GET /models), sorted: [{ id, prices }] (prices when the server lists them). */
export async function listRemoteModels(cfg, signal) {
  const data = await (await call(cfg, '/models', { signal })).json();
  const list = Array.isArray(data) ? data : data?.data || data?.models || [];
  return list.map((m) => (typeof m === 'string' ? { id: m, prices: null } : { id: m?.id || m?.name, prices: pricesOf(m) }))
    .filter((m) => m.id).sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Prices in US dollars per million tokens ({ input, cached, output }) from a /models entry, or null.
 * Requesty lists input_price / cached_price / output_price per token; OpenRouter lists
 * pricing.prompt / pricing.completion / pricing.input_cache_read per token, as strings.
 */
export function pricesOf(m) {
  const num = (v) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v) * 1e6);
  const p = m?.pricing && !Array.isArray(m.pricing) ? m.pricing : {};
  const input = num(m?.input_price ?? p.prompt ?? p.input);
  const output = num(m?.output_price ?? p.completion ?? p.output);
  if (input == null || output == null || input < 0 || output < 0) return null;
  const round = (x) => Math.round(x * 1e6) / 1e6;
  return { input: round(input), cached: round(num(m?.cached_price ?? p.input_cache_read) ?? input), output: round(output) };
}

/** Token counts (and the cost, when the server reports it) of one response's "usage" object. */
export function readUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const input = Number(u.prompt_tokens ?? u.input_tokens ?? 0) || 0;
  const output = Number(u.completion_tokens ?? u.output_tokens ?? 0) || 0;
  const cached = Number(u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? u.input_tokens_details?.cached_tokens ?? 0) || 0;
  const cost = typeof u.cost === 'number' && Number.isFinite(u.cost) ? u.cost : null;
  return input || output ? { input, cached: Math.min(cached, input), output, cost } : null;
}

// Servers that rejected stream_options (older OpenAI-compatible servers): stream without it.
const noStreamUsage = new Set();
// Server + model pairs that rejected the reasoning setting: they get requests without it.
const noReasoningParam = new Set();

/** Reasoning levels offered in the panel. 'default' sends nothing (the model's own default). */
export const REASONING_LEVELS = ['default', 'off', 'low', 'medium', 'high'];

/**
 * Request fields for a reasoning level. Most servers (OpenAI, Requesty, OpenRouter, Ollama…) take
 * reasoning_effort, with "none" for off. Gemini through Requesty/OpenRouter reads "none" as a level,
 * so off is sent as reasoning: { enabled: false } there (Gemini 3 Flash still thinks a little).
 */
export function reasoningFields(cfg, level) {
  if (!level || level === 'default' || !REASONING_LEVELS.includes(level)) return {};
  if (/gemini/i.test(cfg.model)) return level === 'off' ? { reasoning: { enabled: false } } : { reasoning_effort: level };
  return { reasoning_effort: level === 'off' ? 'none' : level };
}
/** True when this server and model ignored the reasoning setting of the last request (it rejected it). */
export const reasoningIgnored = (cfg) => noReasoningParam.has(`${normalizeBaseUrl(cfg.baseUrl)} ${cfg.model}`);

/**
 * POST /chat/completions with the reasoning setting and, when streaming, the usage report. A server
 * that rejects one of them (400) gets the request again without it, and is remembered.
 */
async function postChat(cfg, body, reasoning, signal, onWire) {
  const base = normalizeBaseUrl(cfg.baseUrl);
  const pair = `${base} ${cfg.model}`;
  if (!noReasoningParam.has(pair)) Object.assign(body, reasoningFields(cfg, reasoning));
  if (body.stream && !noStreamUsage.has(base)) body.stream_options = { include_usage: true };
  for (let attempt = 0; ; attempt++) {
    try {
      const sent = JSON.stringify(body);
      const res = await call(cfg, '/chat/completions', { method: 'POST', body: sent, signal });
      onWire?.({ request: sent }); // the body exactly as the server took it (a retry may drop a field)
      return res;
    } catch (e) {
      const msg = e?.message || '';
      if (attempt > 2 || !/ answered (400|422)/.test(msg)) throw e;
      if (body.stream_options && /stream_options|include_usage/i.test(msg)) {
        noStreamUsage.add(base); delete body.stream_options;
      } else if ((body.reasoning_effort || body.reasoning) && /reason|effort|think/i.test(msg)) {
        noReasoningParam.add(pair); delete body.reasoning_effort; delete body.reasoning;
      } else throw e;
    }
  }
}

/** A larger token limit when the model is asked to reason more (the reasoning counts against it). */
const reasoningFloor = (level) => (level === 'high' ? 16000 : level === 'medium' ? 8192 : 4096);

/**
 * One chat completion. Streams when onText is given (onText receives the text so far).
 * maxTokens is a floor-raised limit: large models stop on their own, and "reasoning" models spend
 * part of the budget on hidden thinking before they write the answer.
 */
export async function remoteChat(cfg, messages, { maxTokens = 256, onText, onUsage, onWire, reasoning, signal } = {}) {
  const body = {
    model: cfg.model,
    messages,
    max_tokens: Math.max(reasoningFloor(reasoning), maxTokens * 4),
    temperature: 0.3,
    stream: !!onText
  };
  const res = await postChat(cfg, body, reasoning, signal, onWire);
  let usage = null;
  let text = '';
  let finish = null;
  if (!onText) {
    const data = await res.json();
    onWire?.({ response: data });
    const choice = data?.choices?.[0];
    text = choice?.message?.content ?? choice?.text ?? '';
    finish = choice?.finish_reason;
    usage = data?.usage;
  } else {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const m = /^data:\s*(.*)$/.exec(line.trim());
        if (!m || m[1] === '[DONE]') continue;
        let chunk;
        try { chunk = JSON.parse(m[1]); } catch { continue; }
        if (chunk?.error) throw new Error(`${hostOf(cfg.baseUrl)}: ${chunk.error.message || JSON.stringify(chunk.error)}`);
        if (chunk?.usage) usage = chunk.usage;
        const choice = chunk?.choices?.[0];
        const piece = choice?.delta?.content ?? choice?.text ?? '';
        if (choice?.finish_reason) finish = choice.finish_reason;
        if (piece) { text += piece; onText(text); }
      }
    }
  }
  if (onText) onWire?.({ response: { streamed: true, content: text, finish_reason: finish, usage } }); // the stream's pieces joined
  onUsage?.(usage);
  if (Array.isArray(text)) text = text.map((p) => p?.text || '').join(''); // content as parts
  if (!String(text).trim() && finish === 'length') {
    throw new Error(`${cfg.name || cfg.model} used its whole token limit on hidden reasoning and wrote no answer. Try again, or turn reasoning off or lower.`);
  }
  return String(text || '');
}

/**
 * One chat completion with tools (OpenAI "tool calling"). Not streamed.
 * Returns { content, toolCalls: [{ id, name, args, raw }], message } where message is the assistant
 * message to put back into the conversation.
 */
export async function remoteChatTools(cfg, messages, tools, { maxTokens = 1500, toolChoice = 'auto', onUsage, onWire, reasoning, signal } = {}) {
  const body = {
    model: cfg.model,
    messages,
    tools,
    tool_choice: toolChoice,
    max_tokens: Math.max(reasoningFloor(reasoning), maxTokens * 2),
    temperature: 0.2
  };
  const data = await (await postChat(cfg, body, reasoning, signal, onWire)).json();
  onWire?.({ response: data });
  onUsage?.(data?.usage);
  const choice = data?.choices?.[0];
  const msg = choice?.message || {};
  let content = msg.content ?? '';
  if (Array.isArray(content)) content = content.map((p) => p?.text || '').join('');
  const toolCalls = (Array.isArray(msg.tool_calls) ? msg.tool_calls : []).map((t, i) => {
    const raw = t?.function?.arguments ?? '{}';
    let args = null;
    try { args = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw; } catch { /* reported to the model */ }
    return { id: t?.id || `call_${Date.now()}_${i}`, name: t?.function?.name || '', args, raw: typeof raw === 'string' ? raw : JSON.stringify(raw) };
  });
  if (!String(content).trim() && !toolCalls.length && choice?.finish_reason === 'length') {
    throw new Error(`${cfg.name || cfg.model} used its whole token limit on hidden reasoning and did nothing. Try again, or turn reasoning off or lower.`);
  }
  const message = { role: 'assistant', content: String(content || '') };
  if (toolCalls.length) message.tool_calls = toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.raw } }));
  return { content: String(content || ''), toolCalls, message, usage: data?.usage || null };
}
