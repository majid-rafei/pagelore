// The models of the panel: OpenAI-compatible servers (see api-models.js). A cloud API, or a model on
// this computer served by Ollama, LM Studio or a similar app.
import { API_PREFIX, hostOf, isLocalServer, remoteChat, remoteChatTools, readUsage } from './api-models.js';

const INPUT_CHARS = 24000; // the page text one request takes (models have large context windows)

let apiModels = []; // see api-models.js
export function setApiModels(list) { apiModels = Array.isArray(list) ? list : []; }

/** Everything about one model choice: { key, api: config, label, local, inputChars }, or null if it does not exist (any more). */
export function modelSpec(key) {
  if (!String(key || '').startsWith(API_PREFIX)) return null;
  const api = apiModels.find((m) => m.id === key);
  if (!api) return null;
  const local = isLocalServer(api.baseUrl);
  return { key, api, local, label: `${api.name} · ${local ? 'this computer' : 'API'} (${hostOf(api.baseUrl)})`, inputChars: INPUT_CHARS };
}
export const modelChoices = () => apiModels.map((m) => modelSpec(m.id));
/** The model new tabs start with when the saved choice is gone: the first one, or null when there is none. */
export const firstModel = () => apiModels[0]?.id || null;

// Each run binds its model to its AbortSignal: tabs can use different models at the same time.
const boundModels = new WeakMap(); // AbortSignal -> model key
export function bindModel(signal, key) { if (signal) boundModels.set(signal, key); }
const boundReasoning = new WeakMap(); // AbortSignal -> 'default' | 'off' | 'low' | 'medium' | 'high'
export function bindReasoning(signal, level) { if (signal) boundReasoning.set(signal, level); }

const NO_MODEL = 'No model is set up yet. Add one in Settings → Models: a model on this computer (Ollama, LM Studio) or an API.';
function specFor(signal) {
  const key = boundModels.get(signal);
  const spec = modelSpec(key);
  if (spec) return spec;
  throw new Error(key ? 'This model was removed in Settings. Choose another model.' : NO_MODEL);
}

function cleanOutput(text) {
  return String(text || '')
    .replace(/<think>[\s\S]*?(<\/think>|$)/g, '')
    .replace(/<\|im_end\|>|<\|endoftext\|>/g, '')
    .trim();
}

// ----- Usage (tokens and cost), reported per run -----
const usageListeners = new WeakMap(); // AbortSignal -> (usage) => void

/**
 * Called after every request of the run bound to `signal` with
 * { input, cached, output, cost, local, ms } (cost in US dollars, null when neither the server nor saved prices give it).
 */
export function onUsage(signal, fn) { if (signal) usageListeners.set(signal, fn); }

// ----- Model log: every request (the messages as sent) and the reply, for the user to download.
const callListeners = new WeakMap(); // AbortSignal -> (call) => void

/**
 * Called after every model request of the run bound to `signal` (also a failed one) with
 * { model, kind: 'chat'|'tools', request, response, reply, toolCalls, usage, ms, error }.
 */
export function onModelCall(signal, fn) { if (signal) callListeners.set(signal, fn); }

function callRecorder(signal, spec, kind, messages, tools) {
  const fn = callListeners.get(signal);
  if (!fn) return null;
  const t0 = performance.now();
  const rec = { time: Date.now(), model: spec.label, kind, messages: structuredClone(messages), tools: (tools || []).map((t) => t.function?.name).filter(Boolean) };
  return {
    usage: (u) => { rec.usage = u ? readUsage(u) : null; },
    // The request body exactly as sent (a string) and the reply exactly as received. The body has
    // the messages, so the copy above is dropped (the log can hold hundreds of requests).
    wire: (w) => { Object.assign(rec, w); if (w.request) delete rec.messages; },
    done: (fields) => { try { fn({ ...rec, ...fields, ms: Math.round(performance.now() - t0) }); } catch { /* the log never fails a request */ } }
  };
}
const recorded = async (rec, run, reply) => {
  try {
    const out = await run();
    rec?.done(reply(out));
    return out;
  } catch (e) {
    rec?.done({ error: e?.name === 'AbortError' ? 'Stopped' : String(e?.message || e) });
    throw e;
  }
};

function usageReporter(signal, api) {
  const fn = usageListeners.get(signal);
  const t0 = performance.now();
  // A server on this computer or network (Ollama, LM Studio…) has no API bill, unless prices were saved.
  const local = !api.prices && isLocalServer(api.baseUrl);
  return (raw) => {
    const u = readUsage(raw);
    if (!fn) return;
    if (!u) { fn({ input: 0, cached: 0, output: 0, cost: null, unknown: true, local }); return; }
    const p = api.prices;
    if (u.cost == null && p) u.cost = ((u.input - u.cached) * p.input + u.cached * (p.cached ?? p.input) + u.output * p.output) / 1e6;
    fn({ ...u, local, ms: performance.now() - t0 });
  };
}

/**
 * One chat completion with the model of the run bound to `signal`.
 * @param {{role:string, content:string}[]} messages
 * @param {{maxTokens?:number, onText?:(text:string)=>void, signal?:AbortSignal}} opts
 */
export async function chat(messages, { maxTokens = 256, onText, signal } = {}) {
  const spec = specFor(signal);
  if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
  const rec = callRecorder(signal, spec, 'chat', messages);
  const report = usageReporter(signal, spec.api);
  const text = await recorded(rec, () => remoteChat(spec.api, messages, { maxTokens, signal, reasoning: boundReasoning.get(signal), onWire: rec?.wire,
    onUsage: (u) => { rec?.usage(u); report(u); }, onText: onText && ((t) => onText(cleanOutput(t))) }), (t) => ({ reply: t }));
  return cleanOutput(text);
}

/** Chat with tools, for the agent. */
export async function chatWithTools(messages, tools, { maxTokens, toolChoice, signal } = {}) {
  const spec = specFor(signal);
  if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
  const rec = callRecorder(signal, spec, 'tools', messages, tools);
  return recorded(rec, () => remoteChatTools(spec.api, messages, tools, { maxTokens, toolChoice, signal, reasoning: boundReasoning.get(signal), onWire: rec?.wire, onUsage: usageReporter(signal, spec.api) }),
    (r) => ({ reply: r.content, toolCalls: r.toolCalls.map((t) => ({ name: t.name, args: t.raw })), usage: r.usage ? readUsage(r.usage) : null }));
}

/** How many characters of page or file text one request of this run takes. */
export const inputBudget = (signal) => modelSpec(boundModels.get(signal))?.inputChars || INPUT_CHARS;
