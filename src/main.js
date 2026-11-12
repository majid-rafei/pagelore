import './style.css';
import { formatModelLog } from './model-log.js';
import { firstModel, bindModel, bindReasoning, modelSpec, modelChoices, setApiModels, onUsage, onModelCall } from './llm.js';
import { loadApiModels, saveApiModels, onApiModelsChange, newApiModelId, normalizeBaseUrl, hostOf, requestHostAccess, listRemoteModels, remoteChat, REASONING_LEVELS, reasoningIgnored } from './api-models.js';
import { PageHandle, PageAccessError, requestAllSitesAccess } from './page.js';
import { summarizePage } from './features/summarize.js';
import { relevantPassages, citedSources } from './features/passages.js';
import { smartSearch } from './features/search.js';
import { fieldsToWrite, followUpTargets, proposeFill, writingContext } from './features/form.js';
import { runAgent, tabBrowser, siteOf } from './features/agent.js';
import { renderMarkdown } from './markdown.js';
import { listHistory, saveHistory, patchHistory, deleteHistory, deleteAllHistory, newHistoryId, HISTORY_TYPES } from './history.js';
import { createAttachmentStore } from './attachments.js';
import { LANGUAGE_CHOICES, languageName } from './text.js';
import { WRITING_STYLES, DEFAULT_STYLE, CUSTOM_STYLE_MAX, setWritingStyle } from './writing-style.js';

// The panel is shared by all tabs of its window, but every tab gets its own session: its own
// Q&A history, output, attachments, search hits, form preview, running task and chosen model.
// The settings and the list of models are shared. Models are OpenAI-compatible servers: an app on
// this computer (Ollama, LM Studio…) or a cloud API.

const $ = (id) => document.getElementById(id); // global (non-session) elements
// settings.model is the model of the last choice: new tabs start with it.
const settings = { model: null, lang: 'auto', profile: '', summaryLength: 'medium', confirmAll: false, writingStyle: DEFAULT_STYLE, customStyle: '', verifyWritten: true, agentPace: 3, reasoning: 'default', compactAt: 200000, logModelCalls: false };

// The session markup in sidepanel.html is a template: each tab gets a clone, and only the clone of
// the active tab is attached to the document (so element ids stay unique). Detached clones keep
// running and updating in the background.
const template = $('session');
const sessionSlot = document.createComment('session');
template.replaceWith(sessionSlot);

/** First n characters without splitting an emoji or other surrogate pair. */
const clip = (text, n) => Array.from(String(text || '')).slice(0, n).join('');
/** The label of a form's "Add …" button without a leading "+" ("+ Add skill" → "Add skill"). */
const addName = (adder) => String(adder.label || '').replace(/^[\s+]+/, '');
const fieldName = (f) => f.label || f.name || `Field ${f.id}`;
// The same field after the site redrew the form (its id changes, its locator does not).
const fieldKey = (f) => (f.locator ? `${f.locator.key}#${f.locator.nth}` : `id${f.id}`);

const sessions = new Map(); // tabId -> Session
let shown = null;           // Session currently displayed

// ---------- Settings persistence ----------
async function loadSettings() {
  try { Object.assign(settings, await chrome.storage.local.get(Object.keys(settings))); } catch { /* defaults */ }
  setApiModels(await loadApiModels());
  if (!modelSpec(settings.model)) settings.model = firstModel();
  if (!REASONING_LEVELS.includes(settings.reasoning)) settings.reasoning = 'default';
  renderModelSelect();
  renderApiModels();
  if (!LANGUAGE_CHOICES.includes(settings.lang)) settings.lang = 'auto';
  $('langSelect').replaceChildren(...LANGUAGE_CHOICES.map((code) =>
    new Option(code === 'auto' ? 'Auto (same as the question or page)' : languageName(code), code, false, code === settings.lang)));
  $('verifyWritten').checked = settings.verifyWritten;
  $('logModelCalls').checked = settings.logModelCalls;
  $('agentPace').value = String(settings.agentPace);
  $('compactAt').value = String(settings.compactAt ?? 200000);
  if (!WRITING_STYLES[settings.writingStyle]) settings.writingStyle = DEFAULT_STYLE;
  $('styleSelect').replaceChildren(...Object.entries(WRITING_STYLES).map(([key, s]) => new Option(s.label, key, false, key === settings.writingStyle)));
  $('styleCustom').value = settings.customStyle;
  applyWritingStyle();
}
function applyWritingStyle() {
  setWritingStyle(settings.writingStyle, settings.customStyle);
  $('styleCustom').classList.toggle('hidden', settings.writingStyle !== 'custom');
}
function save(key, value) {
  settings[key] = value;
  chrome.storage.local.set({ [key]: value }).catch(() => {});
}

// ---------- Model (chosen per tab) ----------
/** The model of the shown tab (falls back to the default when its model was removed). */
function shownModel() {
  if (shown && !modelSpec(shown.model)) shown.model = modelSpec(settings.model) ? settings.model : firstModel();
  return shown?.model || settings.model;
}
function renderModelSelect() {
  const choices = modelChoices();
  const group = (label, list) => {
    const g = document.createElement('optgroup');
    g.label = label;
    g.append(...list.map((m) => new Option(m.label, m.key)));
    return g;
  };
  const local = choices.filter((m) => m.local);
  const api = choices.filter((m) => !m.local);
  $('modelSelect').replaceChildren(...(choices.length ? [] : [new Option('No model yet: add one below', '')]),
    ...(local.length ? [group('On this computer', local)] : []), ...(api.length ? [group('API (sends data to the server)', api)] : []));
  $('modelSelect').value = shownModel() || '';
  $('reasoningSelect').value = shown?.reasoning || settings.reasoning;
  renderModelState();
}
function renderModelState() {
  const spec = modelSpec(shownModel());
  // The header names the model of this tab (the model list is on the Settings page).
  $('modelState').textContent = spec ? `${spec.api.name} · ${spec.local ? 'this computer' : 'API'}` : 'No model: set one up';
  $('modelState').title = spec ? `${spec.label}: the text an action needs is sent to ${hostOf(spec.api.baseUrl)}. Click to change the model.` : 'Click to add a model.';
  $('modelState').classList.toggle('ready', !!spec);
  $('apiNote').classList.toggle('hidden', !spec);
  const ignored = !!spec && reasoningIgnored(spec.api);
  $('reasoningRow').classList.toggle('ignored', ignored);
  $('reasoningSelect').title = ignored ? `${hostOf(spec.api.baseUrl)} rejected the reasoning setting for this model, so it uses the model's default.` : '';
  if (spec) $('apiNote').textContent = spec.local
    ? `This tab uses ${spec.api.name}, which runs on ${hostOf(spec.api.baseUrl)} (this computer or your network): nothing is sent to the internet for the model.`
    : `This tab uses ${spec.api.name}, which runs on ${hostOf(spec.api.baseUrl)}: the page text, your saved info and attached files that an action needs are sent there.`;
}
/** A tab's model can't change while that tab runs a task. */
function renderGlobalBusy() {
  const busy = !!shown?.controller;
  $('modelSelect').disabled = busy;
  $('reasoningSelect').disabled = busy;
  renderModelState();
  renderSessionInfo();
}

/**
 * Brief feedback on a button whose action changes nothing visible (copy, download): its label
 * becomes e.g. “✓ Copied” for a moment, then goes back.
 */
function flash(button, text, { ok = true, ms = 1600 } = {}) {
  if (!button) return;
  button.dataset.label ??= button.textContent;
  clearTimeout(button.flashTimer);
  button.textContent = text;
  button.classList.toggle('flash-ok', ok);
  button.classList.toggle('flash-fail', !ok);
  button.flashTimer = setTimeout(() => {
    button.textContent = button.dataset.label;
    delete button.dataset.label;
    button.classList.remove('flash-ok', 'flash-fail');
  }, ms);
}
const downloaded = (button) => flash(button, '✓ Downloaded');

/** Saves text as a file in the Downloads folder. */
function downloadFile(name, content, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
const stamp = () => { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; };

/**
 * A history entry (a chat, summary, search or form fill) as a JSON file: everything that is saved
 * with it, and the model log of its requests when one was kept in this panel. Never has API keys.
 */
function exportEntry(e, modelLog = []) {
  const iso = (t) => (t ? new Date(t).toISOString() : null);
  const data = {
    format: 'local-ai-browser-assistant/history-entry', version: 1,
    exportedAt: new Date().toISOString(), extensionVersion: chrome.runtime.getManifest?.().version || '',
    type: CHAT_TYPES.has(e.type) ? 'chat' : e.type, title: e.title, url: e.url, pages: e.pages || [],
    createdAt: iso(e.createdAt), updatedAt: iso(e.updatedAt),
    turns: e.turns,
    ...(e.memory ? { memory: e.memory } : {}),
    ...(e.data ? { data: e.data } : {}),
    ...(e.files?.length ? { files: e.files } : {}),
    ...(modelLog.length ? { modelLog: modelLog.map(({ request, ...c }) => ({ ...c, time: iso(c.time), ...(request ? { request: parseOr(request) } : {}) })) } : {})
  };
  downloadFile(`${fileStem(data.type, e.title)}.json`, JSON.stringify(data, null, 2), 'application/json');
}
const parseOr = (text) => { try { return JSON.parse(text); } catch { return text; } };
/** The start of an exported file's name: "chat-<title>-<date>-<time>". */
const fileStem = (type, title) => `${type}-${String(title || type).replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 40) || type}-${stamp()}`;

const CHAT_TYPES = new Set(['chat', 'agent', 'ask']); // 'agent' and 'ask': entries saved before the two tabs became Chat

// ---------- One tab's session ----------
class Session {
  constructor(tabId) {
    this.tabId = tabId;
    this.title = '';
    this.url = '';               // URL of the tab (when the extension may see it)
    this.model = modelSpec(settings.model) ? settings.model : firstModel();
    this.reasoning = settings.reasoning; // reasoning level of this tab
    this.root = template.cloneNode(true);
    this.root.removeAttribute('id');
    this.attachments = createAttachmentStore();
    this.controller = null;      // AbortController of the running task
    this.searchHandle = null;    // PageHandle of the last search (for prev/next)
    this.pendingFill = null;     // { handle, proposals }
    this.confirmResolver = null;
    this.askResolver = null;     // pending ask_user question of the agent
    this.inbox = [];             // messages the user sent to the running agent
    this.modelLog = [];          // model requests and replies of this tab (Settings → keep a log)
    this.agentChat = null;       // { id, createdAt, url, turns, memory } of the agent conversation in this tab (saved, see chat-store.js)
    this.turnSteps = [];         // { type, text } of the steps of the current turn, kept with the conversation
    this.pages = [];             // { url, title } of the pages the user asked on (links under "Tab:", so they are not lost when the agent navigates)
    this.accessRequest = null;   // permission request started by the Run click
    this.goalPlaceholder = this.$('goal').placeholder;
    this.renderHistory();
    this.wire();
    this.root.querySelector('.tabs button.active')?.click(); // puts the Assistant card where the open tab wants it
    if (!modelChoices().length) this.setOutput('**To start, add a model** in Settings (⚙) → Models: a model on this computer with **Ollama** or **LM Studio** (free, nothing leaves your computer), or any OpenAI-compatible API.');
  }

  $(id) { return this.root.querySelector(`#${id}`); }
  page() { return PageHandle.forTab(this.tabId); }

  // ----- Output helpers -----
  /** The answer area shows Markdown (headings, lists, tables…); `outputText` keeps the text as written. */
  setOutput(text) { this.outputText = String(text ?? ''); renderMarkdown(this.$('output'), this.outputText); }
  setStatus(text) { this.$('status').textContent = text || ''; }
  setSources(sources, handle) {
    this.$('sources').replaceChildren(...(sources || []).map((s) => {
      const b = document.createElement('button');
      b.textContent = `[${s.n}] ${s.file ? `📎 ${s.file}: ` : ''}${clip(s.text, 50)}`;
      b.title = clip(s.text, 600);
      if (s.file) b.addEventListener('click', () => this.setStatus(`From ${s.file}: “${clip(s.text, 300)}…”`));
      else b.addEventListener('click', () => handle?.call('highlightBlocks', s.blockIds).catch((e) => this.showError(e)));
      return b;
    }));
  }
  showError(e) {
    if (e?.name === 'AbortError') { this.setStatus('Stopped.'); return; }
    console.error(e);
    if (e instanceof PageAccessError && this === shown) $('accessBanner').classList.remove('hidden');
    this.setStatus('');
    this.setOutput(`Error: ${e?.message || e}`);
  }

  /** Remembers a page the user asked on (shown as a link under "Tab:"). */
  notePage(url, title) {
    if (!/^https?:/.test(url || '')) return;
    const key = url.split('#')[0];
    const old = this.pages.find((p) => p.url.split('#')[0] === key);
    if (old) { if (title) old.title = title; } else this.pages.push({ url, title: title || url });
    if (this.pages.length > 12) this.pages.splice(1, 1); // keep the first page (where it started) and the latest ones
    if (this === shown) renderSessionInfo();
  }
  mergePages(pages) { for (const p of pages || []) this.notePage(p.url, p.title); }

  // ----- Busy state / running tasks -----
  setBusy(busy) {
    this.root.querySelectorAll('.panel button').forEach((b) => {
      // The Stop/Pause/Copy buttons stay usable (in the Chat tab the Assistant card, with its Stop, is inside the panel).
      if (!b.closest('#confirmBox') && !b.closest('#hitNav') && !b.closest('#agentTalk') && !b.matches('#stop, #stopTask, #pauseTask, #copy')) b.disabled = busy;
    });
    this.$('stop').classList.toggle('hidden', !busy);
    this.$('stopTask').classList.toggle('hidden', !busy);
    if (!busy) { this.$('pauseTask').classList.add('hidden'); this.resume(); }
  }
  /** Pause: the agent stops before its next step until Continue (Stop and messages still work). */
  togglePause() {
    if (this.pause) { this.resume(); this.setStatus('Continuing…'); return; }
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    this.pause = { promise, resolve };
    this.$('pauseTask').textContent = '▶ Continue';
    this.setStatus('Pausing: the agent stops after the step it is on…');
  }
  resume() {
    this.pause?.resolve();
    this.pause = null;
    this.$('pauseTask').textContent = '⏸ Pause';
  }
  waitIfPaused() {
    if (!this.pause) return;
    this.setStatus('Paused. Press Continue to go on, or Stop. A message you send now is read when it continues.');
    return this.pause.promise;
  }
  /** Run an async task with busy UI, cancellation and error reporting. */
  async run(task, { needsModel = true } = {}) {
    if (this.controller) return;
    const controller = new AbortController();
    this.controller = controller;
    this.notePage(this.url, this.title);
    bindModel(controller.signal, this.model);
    bindReasoning(controller.signal, this.reasoning);
    this.setBusy(true);
    renderGlobalBusy();
    // Time, and for API models requests, tokens and cost, shown live under the status line.
    this.lastMeter = this.$('meter').classList.contains('hidden') ? '' : this.$('meter').textContent; // of the previous run
    const meter = { start: Date.now(), end: 0, requests: 0, input: 0, cached: 0, output: 0, cost: 0, unpriced: 0, local: 0, localOut: 0, localMs: 0 };
    this.meter = meter;
    onUsage(controller.signal, (u) => {
      meter.requests++;
      meter.input += u.input; meter.cached += u.cached; meter.output += u.output;
      if (u.local) { meter.local++; meter.localOut += u.output; meter.localMs += u.ms || 0; } else if (u.cost == null) meter.unpriced++; else meter.cost += u.cost;
      this.renderMeter();
    });
    if (settings.logModelCalls) {
      const message = this.$('goal').value.trim();
      onModelCall(controller.signal, (c) => {
        // Chat: which conversation and which of its questions (0 = the first), for one log file per question.
        const chat = this.agentChat ? { chat: this.agentChat.id, turn: this.agentChat.turns.length } : {};
        this.modelLog.push({ ...c, message, ...chat });
        if (this.modelLog.length > 500) this.modelLog.shift();
        this.$('downloadLog').classList.remove('hidden');
      });
    }
    const tick = setInterval(() => this.renderMeter(), 1000);
    this.renderMeter();
    try {
      if (needsModel && !modelSpec(this.model)) {
        throw new Error(this.model ? 'The model of this tab was removed in Settings. Choose another model.'
          : 'No model is set up yet. Open Settings (⚙) → Models and add one: a model on this computer (Ollama, LM Studio) or an API.');
      }
      await task.call(this, controller.signal);
    } catch (e) {
      this.showError(e);
    } finally {
      clearInterval(tick);
      meter.end = Date.now();
      this.renderMeter();
      this.controller = null;
      this.$('agentPlan').classList.add('ended'); // steps left open are shown as not done
      if (this.$('agentPlanBox').classList.contains('stale')) this.$('agentPlanBox').querySelector('.count').textContent = '(from an earlier message: not changed by this one)';
      this.setBusy(false);
      this.hideConfirm();
      this.answerAgent(null);
      this.$('agentTalk').classList.add('hidden');
      this.showAgentChat();
      renderGlobalBusy();
    }
  }

  renderMeter() {
    const m = this.meter;
    const el = this.$('meter');
    if (!m) { el.classList.add('hidden'); el.textContent = ''; return; }
    const secs = Math.round(((m.end || Date.now()) - m.start) / 1000);
    const parts = [`⏱ ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`];
    if (m.requests) {
      parts.push(`${m.requests} request${m.requests > 1 ? 's' : ''}`);
      parts.push(`${tokens(m.input)} tokens in${m.cached ? ` (${tokens(m.cached)} cached)` : ''}, ${tokens(m.output)} out`);
      // Speed of a model on this computer (Ollama, LM Studio…): time spent generating, not the whole run.
      if (m.local && m.localMs > 500 && m.localOut) parts.push(`${(m.localOut / (m.localMs / 1000)).toFixed(1)} tokens/s`);
      if (m.local === m.requests) parts.push('no API cost');
      else if (m.unpriced === m.requests - m.local) parts.push('cost unknown: add the prices in Settings → API models');
      else parts.push(`${m.unpriced ? 'at least ' : ''}${dollars(m.cost)}`);
    }
    el.textContent = parts.join(' · ');
    el.classList.remove('hidden');
  }

  // ----- Features -----
  /** Text of a file the user attached, shaped like an extracted page. */
  fileAsPage(id) {
    const a = this.attachments.get(id);
    if (!a) throw new Error('That attachment was removed.');
    return { title: a.name, url: '', meta: '', blocks: a.blocks };
  }

  async doSummarize(signal) {
    const source = this.$('summarySource').value;
    this.setSources([]);
    this.setOutput('');
    let page;
    if (source === 'page') {
      this.setStatus('Reading page…');
      page = await (await this.page()).call('extract');
    } else {
      page = this.fileAsPage(source);
    }
    const text = await summarizePage({
      page, length: settings.summaryLength, lang: settings.lang, signal,
      onStatus: (t) => this.setStatus(t), onText: (t) => { this.setStatus('Writing summary…'); this.setOutput(t); }
    });
    this.setOutput(text || 'No summary was generated.');
    this.setStatus(`Summary of “${page.title}”`);
    if (text) this.remember({ type: 'summarize', id: newHistoryId(), createdAt: Date.now(), url: page.url || '', title: page.title || 'Summary',
      turns: [{ question: `Summary (${settings.summaryLength}) of “${page.title}”`, answer: text }] });
  }

  showHits(res) {
    const has = res.total > 0;
    this.$('hitNav').classList.toggle('hidden', !has);
    this.$('hitCount').textContent = has ? `${res.index + 1} / ${res.total}` : '';
  }
  async doSearch(signal) {
    const query = this.$('searchQuery').value.trim();
    if (!query) { this.setOutput('Type what you are looking for.'); return; }
    const handle = await this.page();
    this.searchHandle = handle;
    this.setSources([]);
    this.setOutput('');
    // Literal search runs without the model; only the search by meaning needs it.
    const res = await smartSearch({
      pageHandle: {
        call: async (method, ...args) => {
          if (method === 'extract' && !modelSpec(this.model)) throw new Error(`Nothing on this page matches “${query}” exactly. To search by meaning, set up a model in Settings (⚙) → Models.`);
          return handle.call(method, ...args);
        }
      },
      query, signal, onStatus: (t) => this.setStatus(t)
    });
    this.showHits(res);
    this.setStatus('');
    if (res.mode === 'literal') {
      this.setOutput(`Found ${res.total} match${res.total > 1 ? 'es' : ''} for “${query}”.\n\n${res.snippets.map((s) => `• ${s}`).join('\n')}`);
    } else if (res.mode === 'semantic') {
      this.setOutput(`${res.answer ? `${res.answer}\n\n` : ''}${res.matched ? 'The relevant text is highlighted on the page.' : 'Highlighted the most relevant section on the page.'}\n\n“${res.passage.slice(0, 400)}${res.passage.length > 400 ? '…' : ''}”`);
    } else {
      this.setOutput(res.answer || `Could not find anything related to “${query}” on this page.`);
    }
    this.remember({ type: 'search', id: newHistoryId(), createdAt: Date.now(), url: this.url || '', title: query,
      turns: [{ question: query, answer: this.outputText }] });
  }

  async doPrepareFill(signal) {
    const handle = await this.page();
    this.setSources([]);
    this.setStatus('Scanning form fields…');
    const fields = await handle.call('listFields');
    if (!fields.length) { this.setStatus(''); this.setOutput('No fillable form fields were found on this page.'); return; }
    const profile = settings.profile;
    const instruction = this.$('formInstruction').value;
    const files = this.attachments;
    if (!profile.trim() && !instruction.trim() && !files.hasAttachments()) {
      this.setStatus('');
      this.setOutput(`Found ${fields.length} field(s). Attach a file, add your info under “My saved info”, or write an instruction, then try again.`);
      return;
    }
    // Page text gives the model context (what the site and the form are about) when it writes long fields.
    let pageContext = '';
    if (fieldsToWrite(fields, instruction).length) {
      const page = await handle.call('extract', { maxChars: 20000 }).catch(() => null);
      pageContext = writingContext(page);
    }
    const adders = await handle.call('listAdders').catch(() => []);
    const proposals = await proposeFill({
      fields, adders, instruction, profile, pageContext, lang: settings.lang, verify: settings.verifyWritten, signal, onStatus: (t) => this.setStatus(t),
      documentText: files.allText(),
      getExcerpts: (query, maxChars) => files.relevantExcerpts(query, maxChars).map((p) => `[${p.file}] ${p.text}`).join('\n…\n')
    });
    this.setStatus('');
    const failed = proposals.unwritten?.length
      ? proposals.unwritten.map((u) => `\n\nCould not write “${u.label}”: the model's text was unusable${u.output ? ` (it wrote: “${u.output}”)` : ' (it wrote nothing)'}. Run it again, or try another model.`).join('')
      : '';
    // Fields that already hold a value but got no proposal (often left from an earlier fill): cleared
    // unless the user unticks them, so values from another entry do not stay in the form.
    // Only fields of a form or dialog that has a proposal: never a language picker or search box elsewhere on the page.
    const proposed = new Set(proposals.map((p) => p.field.id));
    const boxes = new Set(proposals.map((p) => p.field.box).filter(Boolean));
    const clears = fields.filter((f) => !proposed.has(f.id) && !f.search && f.box && boxes.has(f.box) && (
      (['text', 'textarea'].includes(f.kind) && String(f.value || '').trim()) ||
      (f.kind === 'select' && f.value && f.options?.length && f.value !== f.options[0])));
    const adds = proposals.adds || [];
    // "Add …" buttons with nothing found get an empty row too (unticked): the user sees the button was found,
    // and can type items or ask for them in a follow-up.
    const emptyAdds = adders.filter((a) => !adds.some((x) => x.adder.id === a.id)).map((adder) => ({ kind: 'add', adder, values: [], on: false }));
    const items = [...proposals.map((p) => ({ kind: 'fill', ...p })), ...clears.map((field) => ({ kind: 'clear', field })),
      ...adds.map((a) => ({ kind: 'add', ...a })), ...emptyAdds];
    const noSource = !profile.trim() && !files.hasAttachments()
      ? 'No file is attached and no info is saved, so values could come only from your request. Attach your CV or document (📎; attached files are removed when the extension is reloaded) and scan again.\n\n' : '';
    const skipped = proposals.ruledOut?.length ? `Left out as your request says: ${proposals.ruledOut.map((x) => `“${x}”`).join(', ')}.\n` : '';
    const about = `${noSource}${proposals.subject ? `Filled for: “${proposals.subject}”. To fill it for another item, name it in your request and scan again.\n` : ''}${skipped}${proposals.subject || skipped ? '\n' : ''}`;
    if (!proposals.length && !adds.length) {
      this.setOutput(`${about}Found ${fields.length} field(s), but none matched the information you provided.${failed}`);
      return;
    }
    this.pendingFill = { handle, items, instruction, choice: proposals.choice };
    this.renderFillRows();
    const parts = [`Prepared ${proposals.length} of ${fields.length} field(s)`,
      clears.length && `${clears.length} filled field(s) without a suggestion will be cleared`,
      adds.length && `${adds.reduce((n, a) => n + a.values.length, 0)} item(s) to add with ${adds.map((a) => `“${addName(a.adder)}”`).join(', ')}`].filter(Boolean);
    this.setOutput(`${about}${parts.join('; ')}. Review and edit the values, then click “Apply selected”. Nothing has been entered yet.${failed}`);
    this.rememberFill(instruction.trim() || 'Fill the form', `${about}Values prepared for ${proposals.length} of ${fields.length} field(s):\n\n` +
      `${proposals.map((p) => `${fieldName(p.field)}: ${p.value}`).join('\n')}` +
      `${adds.map((a) => `\n${addName(a.adder)}: ${a.values.join(', ')}`).join('')}${failed}`, instruction);
  }

  /** The review rows of the prepared values (this.pendingFill.items). */
  renderFillRows() {
    this.$('fillItems').replaceChildren(...this.pendingFill.items.map((it, i) => {
      const row = document.createElement('div');
      row.className = `fill-item${it.kind === 'clear' ? ' clear' : ''}`;
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = it.on !== false; cb.dataset.index = i;
      const label = document.createElement('b');
      const src = document.createElement('span');
      src.className = 'src';
      let input;
      if (it.kind === 'add') {
        label.textContent = addName(it.adder);
        input = document.createElement('textarea');
        input.rows = Math.min(8, it.values.length + 1); input.value = it.values.join('\n'); input.dir = 'auto';
        src.textContent = it.values.length ? `one item per line · clicks “${addName(it.adder)}” for each and picks the matching suggestion`
          : 'nothing found in your info · type items, one per line, or ask for them below';
      } else {
        const f = it.field;
        label.textContent = `${fieldName(f)}${f.required && !/\*\s*$/.test(fieldName(f)) ? ' *' : ''}`;
        const value = it.kind === 'clear' ? '' : it.value;
        if (f.options) {
          input = document.createElement('select');
          input.append(...f.options.map((o, k) => new Option(o, o, false, it.kind === 'clear' ? k === 0 : o === value)));
        } else if (f.kind === 'textarea') {
          input = document.createElement('textarea');
          input.rows = it.source === 'written' ? 8 : 3; input.value = value; input.dir = 'auto';
        } else {
          input = document.createElement('input');
          input.type = 'text'; input.value = value; input.dir = 'auto';
        }
        const kind = f.kind === 'text' ? f.type : f.kind;
        if (it.kind === 'clear') {
          if (!f.options) input.placeholder = '(empty)';
          src.textContent = `${kind} · not suggested · now “${String(f.value).length > 80 ? `${String(f.value).slice(0, 80)}…` : f.value}”: it will be cleared. Untick to keep it.`;
        } else {
          src.textContent = `${kind} · from ${{ profile: 'your saved info', file: 'an attached file', model: 'the model', you: 'you', written: 'written by the model, check it' }[it.source] || it.source}`;
        }
      }
      input.dataset.index = i;
      input.style.gridColumn = '2';
      row.append(cb, label, input, src);
      if (it.source === 'written' && (it.issues || it.checkFailed)) {
        // What the check against the user's info found and fixed (API models only).
        const note = document.createElement('div');
        note.className = 'src check-note';
        note.textContent = it.checkFailed ? 'The check against your info could not run: read this text carefully.' : it.issues.length
          ? `Check found ${it.issues.length} problem(s) and fixed them:\n${it.issues.map((x) => `• ${x.quote ? `“${x.quote}”: ` : ''}${x.problem}`).join('\n')}`
          : 'Checked against your info: no problems found.';
        row.append(note);
      }
      return row;
    }));
    this.$('fillPreview').classList.remove('hidden');
  }
  /** Reads the rows as the user edited them back into this.pendingFill.items. */
  syncFillRows() {
    const items = this.pendingFill?.items || [];
    for (const r of this.$('fillItems').children) {
      const it = items[Number(r.querySelector('[data-index]').dataset.index)];
      if (!it) continue;
      it.on = r.querySelector('input[type="checkbox"]').checked;
      const v = r.querySelector('input[type="text"], textarea, select').value;
      if (it.kind === 'add') it.values = v.split('\n').map((x) => x.trim()).filter(Boolean);
      else if (it.kind === 'fill' && v !== it.value) Object.assign(it, { value: v, source: 'you' });
      else if (it.kind === 'clear' && v.trim() && (!it.field.options || v !== it.field.options[0])) Object.assign(it, { kind: 'fill', value: v, source: 'you' });
    }
  }

  /** Saves a scan or a follow-up as a turn of this panel's form-fill history entry. */
  rememberFill(question, answer, instruction) {
    let host = ''; try { host = new URL(this.url).hostname.replace(/^www\./, ''); } catch { /* not a web page */ }
    // Scans in this panel, and scans after opening a saved form fill, continue the same history entry
    // (one entry per session of filling forms, with a turn per scan), and keep the attached files with it.
    this.formEntry ||= { id: newHistoryId(), createdAt: Date.now(), turns: [] };
    this.formEntry.turns = [...this.formEntry.turns, { question, answer }].slice(-20);
    const saved = this.attachments.saved();
    this.remember({ type: 'form', id: this.formEntry.id, createdAt: this.formEntry.createdAt, url: this.url || '', title: instruction.trim() || `Form on ${host || 'a page'}`,
      data: { instruction }, turns: this.formEntry.turns, ...(saved.length ? { files: saved } : {}) });
  }

  /**
   * A follow-up to the prepared values ("also fill Skills"): fills the fields and "Add" buttons it is about,
   * keeping the other rows as the user left them. Asking for another item fills the whole form again.
   */
  async doRefineFill(signal) {
    const pending = this.pendingFill;
    const text = this.$('fillFollowup').value.trim();
    if (!pending || !text) return;
    this.syncFillRows();
    this.setStatus('Scanning form fields…');
    const handle = await this.page();
    pending.handle = handle;
    const fields = await handle.call('listFields');
    const adders = await handle.call('listAdders').catch(() => []);
    const byKey = new Map(fields.map((f) => [fieldKey(f), f]));
    for (const it of pending.items) {
      if (it.field) it.field = byKey.get(fieldKey(it.field)) || it.field;
      if (it.adder) it.adder = adders.find((a) => a.id === it.adder.id) || adders.find((a) => a.label === it.adder.label) || it.adder;
    }
    this.setStatus('Reading your follow-up…');
    const t = await followUpTargets({ text, fields, adders, subject: pending.choice?.subject, signal });
    if (t.redo) {
      // Another item, or everything again: the whole form, with the follow-up added to the request.
      const box = this.$('formInstruction');
      box.value = `${box.value.trim()}\n${text}`.trim();
      this.$('fillFollowup').value = '';
      return this.doPrepareFill(signal);
    }
    let tf = fields.filter((f) => t.fields?.includes(f.id));
    let ta = adders.filter((a) => t.adders?.includes(a.id));
    if (!tf.length && !ta.length) {
      // Not clear which: the fields still without a value, and the "Add" buttons with nothing to add.
      const filled = new Set(pending.items.filter((it) => it.kind === 'fill' && String(it.value || '').trim()).map((it) => fieldKey(it.field)));
      tf = fields.filter((f) => !f.search && !filled.has(fieldKey(f)) && !String(f.value || '').trim());
      ta = adders.filter((a) => !pending.items.some((it) => it.kind === 'add' && it.adder.id === a.id && it.values.length));
    }
    const instruction = `${pending.instruction.trim()}\nFollow-up: ${text}`.trim();
    const files = this.attachments;
    let pageContext = '';
    if (fieldsToWrite(tf, instruction).length) pageContext = writingContext(await handle.call('extract', { maxChars: 20000 }).catch(() => null));
    const res = await proposeFill({
      fields: tf, adders: ta, instruction, profile: settings.profile, pageContext, lang: settings.lang, verify: settings.verifyWritten,
      choice: pending.choice, signal, onStatus: (x) => this.setStatus(x), documentText: files.allText(),
      getExcerpts: (query, maxChars) => files.relevantExcerpts(query, maxChars).map((p) => `[${p.file}] ${p.text}`).join('\n…\n')
    });
    this.setStatus('');
    const changed = [], missing = [];
    for (const f of tf) {
      const p = res.find((x) => x.field.id === f.id);
      if (!p) { missing.push(fieldName(f)); continue; }
      const row = { kind: 'fill', ...p, on: true };
      const i = pending.items.findIndex((it) => it.field && fieldKey(it.field) === fieldKey(f));
      if (i >= 0) pending.items[i] = row; else pending.items.push(row);
      changed.push(`${fieldName(f)}: ${String(p.value).length > 60 ? `${String(p.value).slice(0, 60)}…` : p.value}`);
    }
    for (const a of ta) {
      const got = (res.adds || []).find((x) => x.adder.id === a.id)?.values || [];
      if (!got.length) { missing.push(addName(a)); continue; }
      const row = pending.items.find((it) => it.kind === 'add' && it.adder.id === a.id);
      const values = [...new Set([...(row?.values || []), ...got])];
      if (row) Object.assign(row, { adder: a, values, on: true }); else pending.items.push({ kind: 'add', adder: a, values, on: true });
      changed.push(`${addName(a)}: ${got.join(', ')}`);
    }
    pending.instruction = instruction; // a later follow-up builds on this one
    this.$('fillFollowup').value = '';
    this.renderFillRows();
    const out = [changed.length ? `Updated:\n${changed.map((c) => `• ${c}`).join('\n')}` : 'Nothing new was found.',
      missing.length && `Nothing found in your info for: ${missing.map((m) => `“${m}”`).join(', ')}. Type the values in their rows, or say in a follow-up where they are (for example which section of your CV).`,
      'The other rows are as you left them. Review, then click “Apply selected”.'].filter(Boolean).join('\n\n');
    this.setOutput(out);
    this.rememberFill(text, out, this.$('formInstruction').value);
  }

  async doApplyFill() {
    const pending = this.pendingFill;
    if (!pending) return;
    const rows = [...this.$('fillItems').children].map((r) => {
      const i = Number(r.querySelector('[data-index]').dataset.index);
      return { r, it: pending.items[i], on: r.querySelector('input[type="checkbox"]').checked, value: r.querySelector('input[type="text"], textarea, select').value };
    });
    const updates = rows.filter((x) => x.on && x.it.kind !== 'add').map((x) => ({ id: x.it.field.id, locator: x.it.field.locator, value: x.value }));
    const results = updates.length ? await pending.handle.call('fillFields', updates) : [];
    let ok = results.filter((r) => r.ok).length;
    let bad = results.length - ok;
    for (const x of rows) {
      if (x.it.kind === 'add') continue;
      const res = results.find((y) => y.id === x.it.field.id);
      x.r.classList.toggle('failed', !!res && !res.ok);
      if (res && !res.ok) x.r.querySelector('.src').textContent = `Not applied: ${res.message}`;
    }
    // Then the items of the "Add …" buttons, one click each.
    for (const x of rows.filter((y) => y.on && y.it.kind === 'add')) {
      const values = x.value.split('\n').map((v) => v.trim()).filter(Boolean);
      if (!values.length) continue;
      this.setStatus(`Adding ${values.length} item(s) with “${addName(x.it.adder)}”…`);
      const res = await pending.handle.call('addItems', { id: x.it.adder.id, label: x.it.adder.label, values });
      const failedHere = res.filter((y) => !y.ok);
      const skipped = values.length - res.length;
      ok += res.length - failedHere.length;
      bad += failedHere.length + skipped;
      x.r.classList.toggle('failed', failedHere.length + skipped > 0);
      if (failedHere.length || skipped) {
        x.r.querySelector('.src').textContent = `${failedHere.map((y) => `“${y.value}”: ${y.message}`).join('; ')}${skipped ? `; ${skipped} not tried` : ''}`;
        // Keep only what is left to add, so “Apply selected” can be tried again.
        const done = new Set(res.filter((y) => y.ok).map((y) => y.value));
        x.r.querySelector('textarea').value = values.filter((v) => !done.has(v)).join('\n');
      } else {
        x.r.querySelector('input[type="checkbox"]').checked = false;
      }
    }
    this.setStatus('');
    this.setOutput(`Applied ${ok} value(s)${bad ? `, ${bad} failed (see above)` : ''}. Review the form before submitting it yourself.`);
    if (!bad) { this.$('fillPreview').classList.add('hidden'); this.pendingFill = null; }
  }

  log(entry) {
    if (entry.type === 'status') { this.setStatus(entry.text); return; }
    const li = document.createElement('li');
    li.className = entry.type;
    li.textContent = entry.text;
    li.dir = 'auto';
    this.$('taskLog').append(li);
    this.turnSteps.push({ type: entry.type, text: entry.text });
    this.$('agentStepCount').textContent = `(${this.$('taskLog').children.length})`;
    if (entry.type === 'done') this.setOutput(entry.text);
  }
  askConfirm({ text, reason, risky }) {
    this.$('confirmText').textContent = text;
    this.$('confirmReason').textContent = reason ? `Reason: ${reason}` : '';
    this.$('confirmBox').classList.toggle('risky', risky);
    const box = this.$('confirmBox');
    box.classList.remove('hidden', 'attention');
    // The box sits above the steps and the answer: bring it into view, or a task seems stuck.
    requestAnimationFrame(() => {
      box.scrollIntoView({ block: 'center', behavior: 'smooth' });
      box.classList.add('attention');
      this.$('confirmRun').focus({ preventScroll: true });
    });
    this.setStatus('Waiting for your confirmation…');
    const answer = new Promise((resolve) => { this.confirmResolver = resolve; });
    renderSessionInfo();
    return answer;
  }
  /** The site shows a CAPTCHA or blocks automated use: the user solves it in the tab, or ends browsing. */
  askBlocked(reason) {
    chrome.tabs.update(this.tabId, { active: true }).catch(() => {});
    this.$('confirmRun').textContent = 'Continue';
    this.$('confirmSkip').textContent = 'Finish with what was found';
    const answer = this.askConfirm({
      text: `The website stopped the agent: ${reason}.`,
      reason: 'Solve the check (for example the CAPTCHA) yourself in the tab, then click Continue. The agent never solves CAPTCHAs.',
      risky: false
    });
    return answer.then((d) => {
      this.$('confirmRun').textContent = 'Run';
      this.$('confirmSkip').textContent = 'Skip';
      return { run: 'continue', skip: 'finish' }[d] || 'stop';
    });
  }
  /** The agent needs more steps than allowed: the user allows them, or asks it to finish with what it has. */
  askMoreSteps({ steps, reason, used }) {
    chrome.tabs.update(this.tabId, { active: true }).catch(() => {});
    this.$('confirmRun').textContent = `Allow ${steps} more`;
    this.$('confirmSkip').textContent = 'Finish now';
    const answer = this.askConfirm({
      text: `The agent used ${used} step${used > 1 ? 's' : ''} and asks for ${steps} more.`,
      reason: `${reason ? `Still to do: ${reason}. ` : ''}“Finish now” gives you the answer from what it found so far.`,
      risky: false
    });
    return answer.then((d) => {
      this.$('confirmRun').textContent = 'Run';
      this.$('confirmSkip').textContent = 'Skip';
      return d === 'run' ? steps : d === 'skip' ? 0 : 'stop';
    });
  }
  hideConfirm(decision = 'stop') {
    this.$('confirmBox').classList.add('hidden');
    this.confirmResolver?.(decision);
    this.confirmResolver = null;
    renderSessionInfo();
  }
  /**
   * The Chat tab runs the agent. It gets the passages of the page relevant to the message with its
   * first step, so a question they answer takes one request.
   * After the first message the tab is a conversation, until the user starts a new chat.
   */
  async doRunTask(signal) {
    const text = this.$('goal').value.trim();
    if (!text) { this.setOutput(this.agentChat ? 'Type your message.' : 'Ask about this page, or say what should be done.'); return; }
    const chat = this.agentChat;
    const handle = await this.page();
    if (chat) this.archiveAgentTurn();
    else this.resetAgentUI();
    this.$('agentPlan').classList.remove('ended'); // the plan is live while the agent works
    this.markTurnStart(chat?.memory?.state);
    this.foldAgentBoxes(false);
    this.$('goal').value = '';
    this.showAgentChat(text);
    this.setSources([]);
    this.agentChat = chat || { id: newHistoryId(), createdAt: Date.now(), url: this.url, turns: [] };
    this.showAgentChat();
    const earlier = this.agentChat.turns;
    const memory = await this.runAgentTurn(text, handle, chat?.memory, earlier, signal);
    if (memory) this.agentChat.memory = memory;
    if (this.meter) { this.meter.end = Date.now(); this.renderMeter(); }
    await this.saveAgentChat();
  }
  /** Saved info and the attached-file passages relevant to the text, for the agent. */
  reference(text) {
    return [settings.profile.trim() && `Saved info:\n${settings.profile.trim()}`,
      this.attachments.relevantExcerpts(text, 2500).map((p) => `[${p.file}] ${p.text}`).join('\n…\n')].filter(Boolean).join('\n\n');
  }
  /** Runs the agent; returns its memory, so the next message continues the conversation. */
  async runAgentTurn(text, handle, memory, earlier, signal) {
    signal.addEventListener('abort', () => { this.hideConfirm('stop'); this.answerAgent(null); this.resume(); });
    this.$('pauseTask').classList.remove('hidden');
    await this.accessRequest?.catch(() => false);
    const tab = await chrome.tabs.get(this.tabId);
    // The passages of the open page most relevant to the message: a question they answer needs no tool call.
    let excerpts = '', sources = [];
    try {
      const page = await handle.call('extract');
      ({ context: excerpts, sources } = relevantPassages({ page, question: text, maxChars: 2500, maxPassages: 6,
        onStatus: (t) => this.setStatus(t) }));
    } catch { /* not readable here: the agent reads pages with its tools */ }
    // A chat saved by an older version (begun with a built-in model) has no agent memory: its questions and answers go with the request.
    const before = !memory && earlier.length
      ? `Earlier in this chat:\n${earlier.slice(-4).map((t) => `User: ${t.question}\nAssistant: ${t.answer}`).join('\n\n').slice(-3000)}` : '';
    this.setOutput('Working… The agent continues on this tab even if you switch to another tab. You can send it a message below.');
    this.$('agentTalk').classList.remove('hidden');
    const res = await runAgent({
      goal: text, reference: [this.reference(memory?.goal || text), before].filter(Boolean).join('\n\n'), signal, lang: settings.lang,
      memory, followUp: memory ? text : '', excerpts,
      page: { url: tab.url, title: tab.title },
      browser: tabBrowser(this.tabId, siteOf(new URL(tab.url).hostname), {
        signal, paceMs: (Number(settings.agentPace) || 3) * 1000,
        onWait: (ms) => this.setStatus(`Waiting ${Math.ceil(ms / 1000)} s before opening the next page (to keep the load on the site low)…`),
        onBlocked: (reason) => this.askBlocked(reason)
      }),
      maxSteps: Math.min(40, Math.max(3, Number(this.$('maxSteps').value) || 25)),
      confirmAll: this.$('confirmAll').checked,
      compactAt: Number(settings.compactAt) || 0,
      files: { list: () => this.attachments.list(), text: (id) => this.attachments.get(id)?.text || '' },
      ui: {
        confirm: (c) => this.askConfirm(c),
        ask: (q) => this.askAgentQuestion(q),
        moreSteps: (r) => this.askMoreSteps(r),
        takeMessages: () => this.inbox.splice(0),
        waitIfPaused: () => this.waitIfPaused()
      },
      onEvent: (e) => this.agentEvent(e)
    });
    this.setStatus(`Finished in ${res.steps} step${res.steps > 1 ? 's' : ''}.`);
    this.setOutput(res.answer);
    // Excerpts it cited can be highlighted, while the tab still shows that page.
    if (sources.length && /\[\d+\]/.test(res.answer || '')) {
      const now = await chrome.tabs.get(this.tabId).catch(() => null);
      if (now?.url === tab.url) { this.setStatus(`${this.$('status').textContent} Sources (click to highlight in page):`); this.setSources(citedSources(res.answer, sources), handle); }
    }
    return res.memory;
  }
  /** The current turn as data: shown in the history and saved with the conversation. */
  currentTurn(meter) {
    const { plan = [], notes = [], results = [] } = this.agentChat?.memory?.state || {};
    return { question: this.agentQuestion, answer: this.outputText, steps: [...this.turnSteps], meter,
      ...(plan.length || notes.length || results.length ? { state: structuredClone({ plan, notes, results }) } : {}) };
  }
  async saveAgentChat() {
    const c = this.agentChat;
    await this.remember({ type: 'chat', id: c.id, title: c.turns[0]?.question || this.agentQuestion, url: c.url, createdAt: c.createdAt,
      turns: [...c.turns, this.currentTurn(this.$('meter').textContent)], ...(c.memory ? { memory: c.memory } : {}),
      files: this.attachments.saved() });
    this.$('exportChat').classList.remove('hidden');
  }

  // ----- History -----
  /** Saves an entry in the history (a failure to save is shown, but does not fail the task). */
  async remember(entry) {
    const { restored, ...rest } = entry;
    if (this.pages.length) rest.pages = this.pages.map(({ url, title }) => ({ url, title }));
    try { await saveHistory(rest); } catch (e) { this.setStatus(`${this.$('status').textContent} Not saved in the history: ${e?.message || e}`); }
    this.renderHistory();
  }
  /** The history, newest first, above the tabs. */
  async renderHistory() {
    const entries = await listHistory();
    this.$('historyCount').textContent = entries.length ? `(${entries.length})` : '';
    const openIds = new Set([this.agentChat?.id].filter(Boolean));
    this.$('historyList').replaceChildren(...entries.map((e) => {
      const li = document.createElement('li');
      if (openIds.has(e.id)) li.className = 'open';
      const title = Object.assign(document.createElement('button'), { className: 'entry-title',
        title: CHAT_TYPES.has(e.type) ? 'Open and continue this chat' : 'Open' });
      title.append(Object.assign(document.createElement('span'), { className: 'kind', textContent: HISTORY_TYPES[e.type] || e.type }),
        Object.assign(document.createElement('span'), { textContent: e.title, dir: 'auto' }));
      title.addEventListener('click', () => this.openHistory(e));
      let host = ''; try { host = new URL(e.url).hostname.replace(/^www\./, ''); } catch { /* no page */ }
      const n = e.turns.length;
      const meta = Object.assign(document.createElement('div'), { className: 'hint',
        textContent: [host, new Date(e.updatedAt).toLocaleString(), n > 1 ? `${n} questions` : ''].filter(Boolean).join(' · ') });
      const del = Object.assign(document.createElement('button'), { className: 'text-button', textContent: 'Delete' });
      del.addEventListener('click', async () => { await deleteHistory(e.id); this.renderHistory(); });
      const exp = Object.assign(document.createElement('button'), { className: 'text-button', textContent: 'Export',
        title: 'Save this entry as a JSON file (with the model log, when it is the chat open here and a log was kept)' });
      exp.addEventListener('click', () => { exportEntry(e, e.id === this.agentChat?.id ? this.modelLog : []); downloaded(exp); });
      meta.append(' ', exp, ' ', del);
      li.append(title, meta);
      return li;
    }));
  }
  showTab(name) { this.root.querySelector(`.tabs button[data-tab="${name}"]`).click(); }
  /** Opens a history entry in its tab. Ask and Agent conversations continue with the next question. */
  openHistory(e) {
    if (this.controller) return;
    this.$('historyBox').open = false;
    this.meter = null; this.renderMeter();
    this.setSources([]);
    const when = new Date(e.updatedAt).toLocaleString();
    const last = e.turns.at(-1);
    this.mergePages(e.pages || (e.url ? [{ url: e.url, title: CHAT_TYPES.has(e.type) ? '' : e.title }] : []));
    switch (e.type) {
      case 'chat': case 'agent': case 'ask': this.showTab('chat'); this.openAgentChat(e); break;
      case 'summarize':
        this.showTab('summarize');
        this.setOutput(last.answer);
        this.setStatus(`Saved: ${last.question}, ${when}.`);
        break;
      case 'search':
        this.showTab('search');
        this.$('searchQuery').value = e.title;
        this.setOutput(last.answer);
        this.setStatus(`Saved search from ${when}. Click Search to run it on this page.`);
        break;
      case 'form':
        this.showTab('form');
        this.$('formInstruction').value = e.data?.instruction || '';
        this.$('fillPreview').classList.add('hidden'); this.pendingFill = null;
        this.formEntry = { id: e.id, createdAt: e.createdAt, turns: [...e.turns] }; // the next scan continues this entry
        this.attachments.restore(e.files); // the files attached when it was saved, attached again
        this.setOutput(last.answer);
        this.setStatus(`Saved from ${when}.${e.files?.length ? ` Its attached file${e.files.length > 1 ? 's are' : ' is'} attached again: ${e.files.map((f) => `📎 ${f.name}`).join(', ')}.` : ''} ` +
          'Open the form and click “Scan form & prepare values” to fill it again.');
        break;
    }
    this.renderHistory();
  }
  /** Shows a saved agent conversation in this tab; the next question continues it. */
  openAgentChat(c) {
    this.resetAgentUI();
    this.agentChat = { id: c.id, createdAt: c.createdAt, url: c.url, turns: [], ...(c.memory ? { memory: c.memory } : {}) };
    this.attachments.restore(c.files); // the files attached in this chat, attached again
    for (const t of c.turns.slice(0, -1)) this.archiveAgentTurn(t);
    const last = c.turns.at(-1);
    this.showAgentChat(last?.question || '');
    this.setOutput(last?.answer || '');
    for (const step of last?.steps || []) this.log(step);
    if (last?.meter) { this.$('meter').textContent = last.meter; this.$('meter').classList.remove('hidden'); }
    const { plan = [], notes = [], results = [] } = c.memory?.state || {};
    this.agentEvent({ type: 'plan', plan }); this.agentEvent({ type: 'notes', notes }); this.agentEvent({ type: 'results', results });
    this.foldAgentBoxes(true); // a saved conversation opens with its answer; the details are one click away
    this.$('exportChat').classList.remove('hidden');
    const files = c.files?.length ? ` Its attached file${c.files.length > 1 ? 's are' : ' is'} attached again: ${c.files.map((f) => `📎 ${f.name}`).join(', ')}.` : '';
    this.setStatus(`Saved conversation from ${new Date(c.updatedAt).toLocaleString()}.${files} Type a follow-up in the box above to continue it.`);
    this.$('goal').focus();
  }
  // ----- Agent UI -----
  /** Folds Plan, Notes, Results and Steps (true), or opens them as while the agent works (false: Notes stays folded). */
  foldAgentBoxes(fold) {
    for (const id of ['agentPlanBox', 'agentResultsBox', 'agentStepsBox']) this.$(id).open = !fold;
    this.$('agentNotesBox').open = false;
  }
  resetAgentUI() {
    this.$('taskLog').replaceChildren();
    this.$('agentStepCount').textContent = '';
    for (const id of ['agentPlan', 'agentNotes', 'agentResults']) this.$(id).replaceChildren();
    for (const id of ['agentPlanBox', 'agentNotesBox', 'agentResultsBox', 'agentAsk', 'agentTalk']) this.$(id).classList.add('hidden');
    this.inbox = [];
    this.modelLog = [];
    this.$('downloadLog').classList.add('hidden');
    this.$('exportChat').classList.add('hidden');
    this.turnBase = null;
    this.$('agentPlanBox').classList.remove('stale');
    for (const c of this.root.querySelectorAll('.agent-box > summary > .count:not(#agentStepCount)')) c.textContent = '';
    this.agentChat = null;
    this.turnSteps = [];
    this.$('agentHistory').replaceChildren();
    this.showAgentChat('');
  }
  /** The question of the current turn above its answer, and the box as "ask a follow-up". */
  showAgentChat(question) {
    if (question != null) {
      this.agentQuestion = question;
      renderMarkdown(this.$('agentCurrentQ'), question);
      this.$('agentCurrentQ').classList.toggle('hidden', !question);
    }
    const n = this.$('agentHistory').children.length;
    this.$('agentHistoryBox').classList.toggle('hidden', !n);
    this.$('agentHistoryCount').textContent = n ? `(${n})` : '';
    const chat = !!this.agentChat;
    this.$('runTask').textContent = 'Send';
    this.$('newTask').classList.toggle('hidden', !chat);
    this.$('goal').placeholder = chat ? 'Ask a follow-up, or ask for more… (Enter to send, Shift+Enter for a new line)' : this.goalPlaceholder;
  }
  /**
   * Moves a turn (question, answer, steps, time and cost) to the folded list of earlier turns:
   * the current one when the user asks a follow-up, or a saved one when a conversation is opened.
   */
  archiveAgentTurn(turn = this.currentTurn(this.lastMeter)) {
    const index = this.agentChat.turns.length;
    this.agentChat.turns.push(turn);
    const el = turnElement(turn, index + 1);
    if (this.turnCalls(index).length) {
      const btn = Object.assign(document.createElement('button'), { className: 'text-button small', textContent: 'Download model log',
        title: 'The requests sent to the model for this question, and its replies, exactly as they were, as a text file' });
      btn.addEventListener('click', () => { this.downloadModelLog(index); downloaded(btn); });
      el.querySelector('.turn-tools').append(btn);
    }
    this.$('agentHistory').prepend(el); // newest first, right under the current answer
    this.$('downloadLog').classList.add('hidden'); // until the new question's first request
    this.$('taskLog').replaceChildren();
    this.$('agentStepCount').textContent = '';
    this.turnSteps = [];
    this.showAgentChat();
  }

  /**
   * A new message starts: what Plan, Notes and Results show is from the earlier messages until the
   * agent changes it. The plan is dimmed until the agent sends a new one; notes and results added or
   * changed now are marked, and each box counts them (Notes is folded, so the count shows it grew).
   */
  markTurnStart(state) {
    const key = (r) => JSON.stringify([r.title, r.url, r.details]);
    this.turnBase = { notes: new Set(state?.notes || []), results: new Set((state?.results || []).map(key)), key };
    const plan = this.$('agentPlanBox');
    plan.classList.toggle('stale', !!state?.plan?.length);
    plan.querySelector('.count').textContent = state?.plan?.length ? '(previous message: waiting for the agent to update it)' : '';
  }
  /** The logged model calls of a question of the open chat (0 = its first). */
  turnCalls(index) {
    const id = this.agentChat?.id;
    return id ? this.modelLog.filter((c) => c.chat === id && c.turn === index) : [];
  }
  /**
   * Saves the model log as a text file: in a chat, of one question and its answer (the current one
   * when no index is given), named like the chat's JSON export; elsewhere, every request of this tab.
   */
  downloadModelLog(index = this.agentChat?.turns.length) {
    const type = 'text/plain;charset=utf-8';
    const c = this.agentChat;
    if (!c) { downloadFile(`model-log-${stamp()}.txt`, formatModelLog(this.modelLog.filter((x) => !x.chat), { title: this.title, url: this.url }), type); return; }
    const calls = this.turnCalls(index);
    const before = index > 0 ? this.turnCalls(index - 1).at(-1) : null;
    const question = index < c.turns.length ? c.turns[index].question : this.agentQuestion;
    const title = c.turns[0]?.question || this.agentQuestion;
    downloadFile(`${fileStem('chat', title)}-q${index + 1}-model-log.txt`,
      formatModelLog(calls, { title, url: c.url || this.url, question, number: index + 1, before }), type);
  }
  /** Saves the open chat, as it is in the history, as a JSON file (with the model log of this tab, if kept). */
  async exportChat() {
    const id = this.agentChat?.id;
    const entry = id && (await listHistory()).find((e) => e.id === id);
    if (!entry) { this.setStatus('This chat is not in the history yet: export it after the answer.'); flash(this.$('exportChat'), 'Not yet', { ok: false }); return; }
    exportEntry(entry, this.modelLog);
    downloaded(this.$('exportChat'));
  }
  agentEvent(e) {
    const list = (id, items, render, isNew = () => false) => {
      const els = items.map((x) => { const el = render(x); if (isNew(x)) el.classList.add('new'); return el; });
      this.$(id).replaceChildren(...els);
      this.$(`${id}Box`).classList.toggle('hidden', !items.length);
      const fresh = items.filter(isNew).length;
      const count = this.$(`${id}Box`).querySelector('.count');
      if (count && id !== 'agentPlan') {
        count.replaceChildren(`(${items.length}`, ...(fresh ? [', ', Object.assign(document.createElement('span'), { className: 'new', textContent: `${fresh} new` })] : []), ')');
      }
    };
    const base = this.turnBase;
    switch (e.type) {
      case 'status': this.setStatus(e.text); break;
      case 'step': this.log({ type: e.kind || 'action', text: e.text }); break;
      case 'plan': {
        list('agentPlan', e.plan, planItem);
        this.$('agentPlanBox').classList.remove('stale'); // the plan of this message
        this.$('agentPlanBox').querySelector('.count').textContent = '';
        break;
      }
      case 'notes': list('agentNotes', e.notes, (n) => li(n), (n) => !!base && !base.notes.has(n)); break;
      case 'results': list('agentResults', e.results, resultItem, (r) => !!base && !base.results.has(base.key(r))); break;
    }
  }
  askAgentQuestion(question) {
    this.$('agentQuestion').textContent = question;
    this.$('agentAsk').classList.remove('hidden');
    this.$('agentTalk').classList.remove('hidden');
    this.$('agentReply').focus();
    this.setStatus('The agent is waiting for your answer.');
    renderSessionInfo();
    return new Promise((resolve) => { this.askResolver = resolve; });
  }
  answerAgent(text) {
    this.$('agentAsk').classList.add('hidden');
    this.askResolver?.(text);
    this.askResolver = null;
    renderSessionInfo();
  }
  sendToAgent() {
    const text = this.$('agentReply').value.trim();
    if (!text || !this.controller) return;
    this.$('agentReply').value = '';
    if (this.askResolver) { this.setStatus('Continuing…'); this.answerAgent(text); }
    else { this.inbox.push(text); this.setStatus('Message sent: the agent reads it at its next step.'); }
  }

  // ----- Attachments -----
  renderAttachments(list) {
    this.$('attachList').replaceChildren(...list.map((a) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.title = `${a.kind}${a.pages ? ` · ${a.pages} page${a.pages > 1 ? 's' : ''}` : ''} · ${a.chars.toLocaleString()} characters`;
      chip.append(`📎 ${a.name}`);
      const x = document.createElement('button');
      x.className = 'chip-x';
      x.textContent = '×';
      x.title = 'Remove';
      x.addEventListener('click', () => this.attachments.remove(a.id));
      chip.append(x);
      return chip;
    }));
    const sel = this.$('summarySource');
    const prev = sel.value;
    sel.replaceChildren(new Option('This page', 'page'), ...list.map((a) => new Option(`📎 ${a.name}`, String(a.id))));
    sel.value = [...sel.options].some((o) => o.value === prev) ? prev : 'page';
  }
  async attachFiles(files) {
    for (const file of files) {
      this.setStatus(`Reading ${file.name}…`);
      try {
        const a = await this.attachments.addFile(file);
        this.setOutput(`Attached “${a.name}” (${a.kind}${a.pages ? `, ${a.pages} page${a.pages > 1 ? 's' : ''}` : ''}) to this tab’s session. It is used by Chat and Form, and can be summarized.`);
      } catch (e) {
        this.setOutput(`Could not read “${file.name}”: ${e.message}`);
      }
    }
    this.setStatus('');
  }

  // ----- Wiring -----
  wire() {
    const on = (id, type, fn) => this.$(id).addEventListener(type, fn);
    const run = (fn, opts) => () => this.run(fn, opts);

    this.root.querySelectorAll('.tabs button').forEach((tab) => tab.addEventListener('click', () => {
      this.root.querySelectorAll('.tabs button').forEach((t) => t.classList.toggle('active', t === tab));
      this.root.querySelectorAll('.panel').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== tab.dataset.tab));
      // In the Chat tab the Assistant card (status, time/cost, answer) goes under the current question.
      const slot = { chat: 'agentAssistantSlot' }[tab.dataset.tab] || 'assistantHome';
      this.$(slot).append(this.$('assistantCard'));
    }));
    this.attachments.onChange((list) => {
      this.renderAttachments(list);
      // A file attached or removed in a saved chat: saved with it now (during a run, it is saved at the end).
      if (this.agentChat && !this.controller) patchHistory(this.agentChat.id, { files: this.attachments.saved() }).catch(() => {});
      if (this.formEntry) patchHistory(this.formEntry.id, { files: this.attachments.saved() }).catch(() => {});
    });
    on('fileInput', 'change', (e) => { this.attachFiles([...e.target.files]); e.target.value = ''; });

    // Settings that live inside the session markup are still global: sync them on show().
    on('summaryLength', 'change', (e) => save('summaryLength', e.target.value));
    on('confirmAll', 'change', (e) => save('confirmAll', e.target.checked));
    on('profile', 'input', (e) => save('profile', e.target.value));

    on('summarize', 'click', run(this.doSummarize));
    on('search', 'click', run(this.doSearch, { needsModel: false }));
    on('searchQuery', 'keydown', (e) => { if (e.key === 'Enter') this.run(this.doSearch, { needsModel: false }); });
    on('prevHit', 'click', () => this.searchHandle?.call('moveHit', -1).then((r) => this.showHits(r)).catch((e) => this.showError(e)));
    on('nextHit', 'click', () => this.searchHandle?.call('moveHit', 1).then((r) => this.showHits(r)).catch((e) => this.showError(e)));
    on('clearHits', 'click', () => { this.searchHandle?.call('clearHighlights').catch(() => {}); this.$('hitNav').classList.add('hidden'); });
    on('prepareFill', 'click', run(this.doPrepareFill));
    on('applyFill', 'click', run(this.doApplyFill, { needsModel: false }));
    on('refineFill', 'click', run(this.doRefineFill));
    on('fillFollowup', 'keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.run(this.doRefineFill); } });
    on('runTask', 'click', () => {
      // Host access for the whole site (subdomains included) lets the agent move between its pages.
      // Permission requests need the click (user gesture), so it starts here, before anything async.
      this.accessRequest = null;
      if (modelSpec(this.model)?.api && /^https?:/.test(this.url)) {
        this.accessRequest = chrome.permissions.request({ origins: [`*://*.${siteOf(new URL(this.url).hostname)}/*`] });
      }
      this.run(this.doRunTask);
    });
    on('agentSend', 'click', () => this.sendToAgent());
    on('deleteAllHistory', 'click', async () => {
      if (!confirm('Delete the whole history?')) return;
      await deleteAllHistory(); this.renderHistory();
    });
    this.$('historyBox').addEventListener('toggle', () => { if (this.$('historyBox').open) this.renderHistory(); });
    on('downloadLog', 'click', () => { this.downloadModelLog(); downloaded(this.$('downloadLog')); });
    on('exportChat', 'click', () => this.exportChat());
    on('newTask', 'click', () => { if (!this.controller) { this.resetAgentUI(); this.setOutput('Ready.'); this.setStatus(''); this.setSources([]); this.meter = null; this.renderMeter(); this.$('goal').focus(); this.renderHistory(); } });
    on('goal', 'keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.$('runTask').click(); } });
    on('agentReply', 'keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.sendToAgent(); } });
    on('confirmRun', 'click', () => this.hideConfirm('run'));
    on('confirmSkip', 'click', () => this.hideConfirm('skip'));
    on('confirmStop', 'click', () => this.hideConfirm('stop'));

    on('stop', 'click', () => this.controller?.abort());
    on('stopTask', 'click', () => this.controller?.abort());
    on('pauseTask', 'click', () => this.togglePause());
    on('copy', 'click', () => {
      const button = this.$('copy');
      if (!this.outputText?.trim()) { flash(button, 'Nothing to copy', { ok: false }); return; }
      navigator.clipboard.writeText(this.outputText).then(() => flash(button, '✓ Copied'),
        (e) => { flash(button, '✗ Not copied', { ok: false }); this.setStatus(`Could not copy: ${e.message || e}`); });
    });
    on('clear', 'click', () => {
      this.setOutput('Ready.'); this.setStatus(''); this.setSources([]);
      if (!this.controller) { this.meter = null; this.renderMeter(); }
      this.$('fillPreview').classList.add('hidden'); this.pendingFill = null;
      this.resetAgentUI();
    });
  }

  /** Refresh the global settings mirrored inside this session's markup. */
  syncSettings() {
    this.$('summaryLength').value = settings.summaryLength;
    this.$('confirmAll').checked = settings.confirmAll;
    if (this.$('profile') !== document.activeElement) this.$('profile').value = settings.profile;
  }

  dispose() {
    this.controller?.abort();
    this.hideConfirm('stop');
    this.root.remove();
  }
}

// ---------- Tab tracking ----------
// In the side panel we follow the active tab of the panel's own window. When sidepanel.html is
// opened as a normal tab (development/testing), we follow the last focused window instead.
// Items of the Plan, Notes and Results lists (the live boxes and the earlier turns).
const li = (text, cls = '') => { const x = document.createElement('li'); x.textContent = text; x.className = cls; x.dir = 'auto'; return x; };
function planItem(s) {
  const x = li('', s.status);
  x.append(Object.assign(document.createElement('span'), { className: 'step', textContent: s.title }));
  if (s.substeps?.length) { const o = document.createElement('ol'); o.append(...s.substeps.map(planItem)); x.append(o); }
  return x;
}
function resultItem(r) {
  const x = li('');
  if (r.url) {
    const a = document.createElement('a');
    a.href = r.url; a.textContent = r.title; a.target = '_blank'; a.rel = 'noopener noreferrer';
    x.append(a);
  } else x.append(Object.assign(document.createElement('b'), { textContent: r.title }));
  x.append(Object.assign(document.createElement('div'), { className: 'hint', textContent: `${r.checked === false ? '(page not opened: not checked) ' : ''}${r.details}` }));
  return x;
}

/**
 * An earlier question and answer of a conversation, as one card in the order of the live view: the
 * question in full, the time and cost, the answer, then Plan, Notes, Results and Steps (folded) as
 * they were at the end of that answer (what the history kept of them).
 */
function turnElement(turn, number) {
  // Folded by default: the summary shows the question on one line; opened, the card shows it in full.
  const el = document.createElement('details');
  el.className = 'turn';
  const head = Object.assign(document.createElement('summary'), { className: 'turn-head' });
  head.append(Object.assign(document.createElement('span'), { className: 'turn-number', textContent: `Question ${number}` }),
    Object.assign(document.createElement('span'), { className: 'turn-preview', textContent: turn.question, dir: 'auto' }));
  const question = Object.assign(document.createElement('div'), { className: 'agent-question', dir: 'auto' });
  renderMarkdown(question, turn.question);
  el.append(head, question);
  if (turn.meter) el.append(Object.assign(document.createElement('div'), { className: 'meter', textContent: turn.meter }));
  const answer = Object.assign(document.createElement('div'), { className: 'output', dir: 'auto' });
  renderMarkdown(answer, turn.answer);
  el.append(answer);
  const box = (label, cls, items, render) => {
    if (!items?.length) return;
    const d = document.createElement('details');
    d.className = 'agent-box';
    const ol = Object.assign(document.createElement('ol'), { className: cls });
    ol.append(...items.map(render));
    const summary = document.createElement('summary');
    summary.append(`${label} `, Object.assign(document.createElement('span'), { className: 'count', textContent: `(${items.length})` }));
    d.append(summary, ol);
    el.append(d);
  };
  const { plan, notes, results } = turn.state || {};
  box('Plan', 'plan ended', plan, planItem);
  box('Notes', 'notes', notes, (n) => li(n));
  box('Results', 'results', results, resultItem);
  box('Steps', 'log', turn.steps, (st) => li(st.text, st.type));
  el.append(Object.assign(document.createElement('div'), { className: 'turn-tools' })); // the model log button, when there is a log
  return el;
}

let selfTabId = null;
let panelWindowId = null;
// Each tab has a panel of its own, with its tab in the address: sidepanel.html?tab=<id> (see public/service-worker.js).
// It stays with that tab and does not follow tab switches. Without ?tab= (a panel left open by an older version, or the
// page opened in a tab), it follows the active tab and keeps a session for each tab.
const pinnedTabId = Number(new URLSearchParams(location.search).get('tab')) || null;
if (pinnedTabId) document.body.classList.add('pinned-panel');

async function activeTab() {
  if (pinnedTabId) return chrome.tabs.get(pinnedTabId).catch(() => null);
  const query = panelWindowId != null ? { active: true, windowId: panelWindowId } : { active: true, lastFocusedWindow: true };
  const [tab] = await chrome.tabs.query(query).catch(() => []);
  return tab && tab.id !== selfTabId ? tab : null;
}

const PLACEHOLDER = -1;
function sessionFor(tabId) {
  let s = sessions.get(tabId);
  if (s) return s;
  // The first real tab adopts the placeholder session shown before any tab was known.
  const placeholder = sessions.get(PLACEHOLDER);
  if (placeholder && tabId !== PLACEHOLDER) { sessions.delete(PLACEHOLDER); placeholder.tabId = tabId; s = placeholder; }
  else s = new Session(tabId);
  sessions.set(tabId, s);
  return s;
}

function show(session) {
  if (shown === session) return;
  shown?.root.remove();
  shown = session;
  session.syncSettings();
  sessionSlot.after(session.root);
  $('accessBanner').classList.add('hidden');
  renderModelSelect();
  renderGlobalBusy();
}

function renderSessionInfo() {
  const info = $('sessionInfo');
  if (!shown) { info.replaceChildren(); return; }
  const title = document.createElement('span');
  title.className = 'tab-title';
  title.textContent = `Tab: ${shown.title || 'current tab'}`;
  title.title = 'Each tab has its own conversation, attachments and results.';
  const others = [...sessions.values()].filter((s) => s !== shown);
  const running = others.filter((s) => s.controller).length;
  const waiting = others.filter((s) => s.confirmResolver || s.askResolver).length;
  const extra = document.createElement('span');
  extra.className = 'others';
  if (others.length) {
    extra.textContent = `${others.length} other tab${others.length > 1 ? 's' : ''}`;
    if (running) {
      const r = document.createElement('span');
      r.className = 'running';
      r.textContent = ` · ${running} running${waiting ? `, ${waiting} awaiting you` : ''}`;
      extra.append(r);
    }
  }
  info.replaceChildren(title, extra);
  if (shown.pages.length) info.append(pageLinks(shown));
}

/** Links to the pages the user asked on in this tab; a click opens the page again in this tab. */
function pageLinks(session) {
  const row = Object.assign(document.createElement('div'), { className: 'tab-pages' });
  row.append(Object.assign(document.createElement('span'), { className: 'label', textContent: 'Your pages:' }));
  const here = (session.url || '').split('#')[0];
  for (const p of session.pages) {
    const a = Object.assign(document.createElement('a'), { href: p.url, textContent: p.title, dir: 'auto' });
    const current = p.url.split('#')[0] === here;
    a.className = current ? 'current' : '';
    a.title = `${p.url}\n${current ? 'Open now.' : session.controller
      ? 'Opens in a new tab (the agent is using this tab).' : 'Click to open it again in this tab; middle-click for a new tab.'}`;
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      if (current) return;
      if (session.controller) chrome.tabs.create({ url: p.url });
      else chrome.tabs.update(session.tabId, { url: p.url });
    });
    a.addEventListener('auxclick', (ev) => { if (ev.button === 1) { ev.preventDefault(); chrome.tabs.create({ url: p.url, active: false }); } });
    row.append(a);
  }
  return row;
}

async function syncToActiveTab() {
  const tab = await activeTab();
  if (!tab) return;
  const s = sessionFor(tab.id);
  if (tab.title) s.title = tab.title;
  if (tab.url) s.url = tab.url;
  show(s);
  renderSessionInfo();
}

chrome.tabs.onActivated.addListener(({ windowId }) => {
  if (pinnedTabId) return;
  if (panelWindowId == null || windowId === panelWindowId) syncToActiveTab();
});
chrome.windows.onFocusChanged.addListener(() => { if (!pinnedTabId && panelWindowId == null) syncToActiveTab(); });
chrome.tabs.onUpdated.addListener((tabId, change) => {
  const s = sessions.get(tabId);
  if (s && change.url) { s.url = change.url; if (s === shown && s.pages.length) renderSessionInfo(); }
  if (s && change.title) { s.title = change.title; if (s === shown) renderSessionInfo(); }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  const s = sessions.get(tabId);
  if (!s) return;
  s.dispose();
  sessions.delete(tabId);
  if (shown === s) { shown = null; syncToActiveTab(); }
  renderGlobalBusy();
});

// ---------- Global wiring ----------
// Restart: a fresh panel is the same as reloading the extension for everything the panel runs.
// Settings, models and the history are kept.
$('restartPanel').addEventListener('click', () => {
  const running = [...sessions.values()].some((s) => s.controller);
  if (running && !confirm('A task is running. Stop it and restart the panel?')) return;
  location.reload();
});
$('modelSelect').addEventListener('change', (e) => {
  if (!shown || shown.controller) return;
  if (!e.target.value) return;
  shown.model = e.target.value;
  save('model', e.target.value); // new tabs start with the last choice; other open tabs keep theirs
  renderModelState();
  $('modelHint').textContent = 'Only this tab uses this model. Other tabs keep their own choice.';
});
$('reasoningSelect').addEventListener('change', (e) => {
  if (!shown || shown.controller) return;
  shown.reasoning = e.target.value;
  save('reasoning', e.target.value); // new tabs start with the last choice
});
$('langSelect').addEventListener('change', (e) => save('lang', e.target.value));
$('verifyWritten').addEventListener('change', (e) => save('verifyWritten', e.target.checked));
$('logModelCalls').addEventListener('change', (e) => save('logModelCalls', e.target.checked));
$('agentPace').addEventListener('change', (e) => save('agentPace', Number(e.target.value) || 3));
$('compactAt').addEventListener('change', (e) => {
  // A whole number of tokens; empty or negative turns compaction off, tiny values would compact on every step.
  const n = Math.max(0, Math.round(Number(e.target.value) || 0));
  const v = n && n < 2000 ? 2000 : n;
  e.target.value = String(v);
  save('compactAt', v);
});
// ---------- Settings page ----------
function showSettings(open) {
  $('settingsView').classList.toggle('hidden', !open);
  $('mainView').classList.toggle('hidden', open);
  $('openSettings').classList.toggle('active', open);
  window.scrollTo(0, 0);
  if (open) $('modelSelect').focus();
}
$('openSettings').addEventListener('click', () => showSettings($('settingsView').classList.contains('hidden')));
$('modelState').addEventListener('click', () => showSettings(true));
$('closeSettings').addEventListener('click', () => showSettings(false));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('settingsView').classList.contains('hidden')) showSettings(false); });
$('styleSelect').addEventListener('change', (e) => { save('writingStyle', e.target.value); applyWritingStyle(); });
$('styleCustom').addEventListener('input', (e) => { save('customStyle', e.target.value.slice(0, CUSTOM_STYLE_MAX)); applyWritingStyle(); });
$('grantAccess').addEventListener('click', () => {
  // Must stay synchronous with the click: permissions.request needs a user gesture.
  requestAllSitesAccess().then((granted) => {
    if (granted) { $('accessBanner').classList.add('hidden'); shown?.setOutput('Access granted. Run the action again.'); }
  }).catch((e) => shown?.showError(e));
});

// ---------- API models (shared by all tabs and windows) ----------
// The list, an Edit form under each model being edited (several can be open), and the Add form
// below the list, which is always there.
const apiEditors = new Map(); // API model id → its open Edit form (kept when the list is redrawn)
function renderApiModels() {
  const list = modelChoices().filter((m) => m.api);
  for (const id of apiEditors.keys()) if (!list.some(({ api }) => api.id === id)) apiEditors.delete(id); // removed elsewhere
  $('apiList').replaceChildren(...list.map(({ api }) => {
    const li = document.createElement('li');
    const row = Object.assign(document.createElement('div'), { className: 'api-row' });
    const name = document.createElement('span');
    name.className = 'grow';
    name.textContent = `${api.name} · ${api.model} · ${hostOf(api.baseUrl)}`;
    const edit = Object.assign(document.createElement('button'), { className: 'text-button', textContent: 'Edit' });
    edit.addEventListener('click', () => {
      if (!apiEditors.has(api.id)) apiEditors.set(api.id, apiForm(api));
      const form = apiEditors.get(api.id);
      li.append(form);
      form.open = true;
      form.querySelector('[data-f="name"]').focus();
    });
    const del = Object.assign(document.createElement('button'), { className: 'text-button', textContent: 'Remove' });
    del.addEventListener('click', async () => {
      if (!confirm(`Remove the model “${api.name}”? Tabs that use it switch to another model.`)) return;
      await saveApiModels((await loadApiModels()).filter((m) => m.id !== api.id));
    });
    row.append(name, edit, del);
    li.append(row);
    if (apiEditors.has(api.id)) li.append(apiEditors.get(api.id));
    return li;
  }));
}
const tokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const dollars = (x) => (x === 0 ? '$0' : x < 0.0001 ? '< $0.0001' : x < 0.01 ? `$${x.toFixed(4)}` : x < 1 ? `$${x.toFixed(3)}` : `$${x.toFixed(2)}`);

let apiFormCount = 0;
/**
 * A form for a new API model (api = null: the Add form) or for editing one. Each form has its own
 * fields, model list and status, so several can be open at once.
 */
function apiForm(api = null) {
  const form = $('apiFormTemplate').content.firstElementChild.cloneNode(true);
  const f = (name) => form.querySelector(`[data-f="${name}"]`);
  const listId = `apiModelOptions${++apiFormCount}`;
  f('options').id = listId;
  f('model').setAttribute('list', listId);
  let listedPrices = new Map(); // prices of the models the server listed (filled in when one is chosen)
  const showPrices = (p) => {
    f('priceIn').value = p?.input ?? '';
    f('priceCached').value = p && p.cached !== p.input ? p.cached : '';
    f('priceOut').value = p?.output ?? '';
  };
  const fill = (a) => {
    form.querySelector('.api-form-title').textContent = a ? `Edit “${a.name}”` : 'Add a model';
    f('name').value = a?.name || ''; f('url').value = a?.baseUrl || ''; f('key').value = a?.apiKey || ''; f('model').value = a?.model || '';
    showPrices(a?.prices);
    f('status').textContent = '';
  };
  fill(api);
  // An Edit form goes away (its changes are dropped); the Add form is emptied and folded.
  const close = () => {
    if (api) { apiEditors.delete(api.id); form.remove(); } else { fill(null); form.open = false; }
  };
  f('model').addEventListener('change', () => { const p = listedPrices.get(f('model').value.trim()); if (p) showPrices(p); });
  /** The form's values as a config; throws a readable error when something is missing. */
  const config = () => {
    const cfg = { name: f('name').value.trim(), baseUrl: f('url').value.trim(), apiKey: f('key').value.trim(), model: f('model').value.trim() };
    const price = (k) => { const v = f(k).value.trim(); return v === '' ? null : Number(v); };
    const [input, cached, output] = [price('priceIn'), price('priceCached'), price('priceOut')];
    if ([input, cached, output].some((v) => v != null && !(v >= 0))) throw new Error('Prices must be numbers of 0 or more.');
    if ((input == null) !== (output == null)) throw new Error('Enter both the input and the output price, or neither.');
    cfg.prices = input == null ? null : { input, cached: cached ?? input, output };
    if (!cfg.baseUrl) throw new Error('Enter the API URL.');
    try { cfg.baseUrl = normalizeBaseUrl(cfg.baseUrl); } catch (e) { throw new Error(e instanceof TypeError ? 'The API URL is not a valid URL.' : e.message); }
    return cfg;
  };
  /** Wires a button. `waitForAccess`: the action talks to the server, so it waits for Chrome's site-access prompt. */
  const action = (button, fn, { waitForAccess = true } = {}) => f(button).addEventListener('click', () => {
    let cfg;
    try { cfg = config(); } catch (e) { f('status').textContent = e.message; return; }
    const access = requestHostAccess(cfg.baseUrl); // must start during the click
    f('status').textContent = 'Working…';
    (waitForAccess ? access : Promise.resolve()).then(() => fn(cfg)).catch((e) => { f('status').textContent = e.message || String(e); });
  });
  action('list', async (cfg) => {
    const models = await listRemoteModels(cfg);
    listedPrices = new Map(models.filter((m) => m.prices).map((m) => [m.id, m.prices]));
    f('options').replaceChildren(...models.map((m) => new Option(m.prices ? `$${m.prices.input} in / $${m.prices.output} out per 1M tokens` : m.id, m.id)));
    const priced = listedPrices.size ? ' Prices are filled in when you choose one (list prices: discounts such as “:flex” or caching are counted when the server reports the cost of each request).' : '';
    f('status').textContent = models.length ? `${models.length} models found: type in the Model field to search them.${priced}` : 'The server listed no models; type the model name.';
    const p = listedPrices.get(f('model').value.trim()); if (p) showPrices(p);
    f('model').focus();
  });
  action('test', async (cfg) => {
    if (!cfg.model) throw new Error('Enter the model name.');
    const t0 = performance.now();
    const reply = await remoteChat(cfg, [{ role: 'user', content: 'Reply with only the word OK.' }], { maxTokens: 16, signal: AbortSignal.timeout(60000) });
    f('status').textContent = `It works: the model replied “${reply.trim().slice(0, 60)}” in ${((performance.now() - t0) / 1000).toFixed(1)} s.`;
  });
  action('save', async (cfg) => {
    if (!cfg.model) throw new Error('Enter the model name.');
    cfg.name ||= cfg.model.split('/').pop();
    const list = await loadApiModels();
    const i = api ? list.findIndex((m) => m.id === api.id) : -1;
    if (i >= 0) list[i] = { ...list[i], ...cfg }; else list.push({ id: newApiModelId(), ...cfg });
    close(); // before saving: the list is redrawn when the models change
    await saveApiModels(list);
    $('modelHint').textContent = `“${cfg.name}” was saved. Choose it in the model list of any tab.`;
  }, { waitForAccess: false });
  // A model on this computer: the app's address, no key and no cost; then the models it has are listed.
  const preset = (button, url, app) => f(button).addEventListener('click', () => {
    f('url').value = url;
    f('key').value = '';
    showPrices(null);
    f('model').placeholder = `a model you downloaded in ${app}`;
    f('list').click(); // still inside this click, so Chrome can ask for access to the app's address
  });
  preset('ollama', 'http://localhost:11434/v1', 'Ollama');
  preset('lmstudio', 'http://localhost:1234/v1', 'LM Studio');
  if (api) f('presets').remove();
  f('cancel').addEventListener('click', close);
  // Folding an Edit form by its title closes it, like Cancel.
  if (api) form.addEventListener('toggle', () => { if (!form.open) close(); });
  return form;
}
$('apiAdd').append(apiForm());
onApiModelsChange((list) => {
  setApiModels(list);
  // Tabs whose model was removed (or that had none yet) switch to the last chosen model, or the first one.
  if (!modelSpec(settings.model)) save('model', firstModel());
  for (const x of sessions.values()) if (!x.controller && !modelSpec(x.model)) x.model = settings.model;
  renderApiModels();
  renderModelSelect();
});

// Dropped files go to the session of the tab being shown.
document.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); document.body.classList.add('dragging'); } });
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
document.addEventListener('drop', (e) => {
  if (!e.dataTransfer?.files.length) return;
  e.preventDefault();
  document.body.classList.remove('dragging');
  shown?.attachFiles([...e.dataTransfer.files]);
});

(async () => {
  await loadSettings();
  const self = await chrome.tabs.getCurrent().catch(() => null);
  if (self) selfTabId = self.id;
  else panelWindowId = (await chrome.windows.getCurrent().catch(() => null))?.id ?? null;
  await syncToActiveTab();
  // Nothing to attach to yet (e.g. opened from a page that is not a tab): show a placeholder session.
  if (!shown) show(sessionFor(PLACEHOLDER));
})();
