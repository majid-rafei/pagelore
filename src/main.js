import './style.css';
import { formatModelLog } from './model-log.js';
import { firstModel, bindModel, bindReasoning, modelSpec, modelChoices, setApiModels, onUsage, onModelCall } from './llm.js';
import { loadApiModels, saveApiModels, onApiModelsChange, newApiModelId, normalizeBaseUrl, hostOf, requestHostAccess, listRemoteModels, remoteChat, REASONING_LEVELS, reasoningIgnored } from './api-models.js';
import { PageHandle, PageAccessError, requestAllSitesAccess } from './page.js';
import { summarizePage, followUpSummary } from './features/summarize.js';
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
const settings = { model: null, lang: 'auto', profile: '', summaryLength: 'medium', confirmAll: false, writingStyle: DEFAULT_STYLE, customStyle: '', verifyWritten: true, agentPace: 3, reasoning: 'default', compactAt: 60000, logModelCalls: false, maxSteps: 25 };

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
  $('compactAt').value = String(settings.compactAt ?? 60000);
  settings.maxSteps = Math.min(300, Math.max(3, Math.round(Number(settings.maxSteps)) || 25));
  for (const s of sessions.values()) s.$('maxSteps').value = String(settings.maxSteps); // tabs opened before the settings loaded
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
// Every tab is a conversation (one history entry, a turn per question); each has its own agent and tools.
const TABS = ['chat', 'summarize', 'search', 'form'];
const TAB_OF_TYPE = { chat: 'chat', agent: 'chat', ask: 'chat', summarize: 'summarize', search: 'search', form: 'form' };
const FILE_TABS = new Set(['chat', 'summarize', 'form']); // conversations that use the attached files (saved with them)
const READY = 'Ready. Page content is treated as untrusted input.';
const filesNote = (files) => (files?.length ? ` Its attached file${files.length > 1 ? 's are' : ' is'} attached again: ${files.map((f) => `📎 ${f.name}`).join(', ')}.` : '');

// ---------- One tab's session ----------
/** Time and, for API models, requests, tokens and cost of a run. */
function meterText(m) {
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
  return parts.join(' · ');
}

class Session {
  constructor(tabId) {
    this.tabId = tabId;
    this.title = '';
    this.url = '';               // URL of the tab (when the extension may see it)
    this.model = modelSpec(settings.model) ? settings.model : firstModel();
    this.reasoning = settings.reasoning; // reasoning level of this tab
    this.root = template.cloneNode(true);
    this.root.removeAttribute('id');
    const order = this.root.querySelector('.steps-order');
    if (order) order.textContent = document.body.classList.contains('steps-newest') ? '↑↓ Newest first' : '↑↓ Oldest first';
    const steps = this.root.querySelector('#maxSteps');
    if (steps) steps.value = String(settings.maxSteps);
    this.attachments = createAttachmentStore();
    this.controller = null;      // AbortController of the running task
    this.searchHandle = null;    // PageHandle of the last search (for prev/next)
    this.pendingFill = null;     // { handle, proposals }
    this.confirmResolver = null;
    this.askResolver = null;     // pending ask_user question of the agent
    this.inbox = [];             // messages the user sent to the running agent
    this.modelLog = [];          // model requests and replies of this tab (Settings → keep a log)
    this.turnSteps = [];         // { type, text } of the steps of the current turn, kept with the conversation
    this.pages = [];             // { url, title } of the pages the user asked on (links under "Tab:", so they are not lost when the agent navigates)
    this.accessRequest = null;   // permission request started by the Run click
    this.goalPlaceholder = this.$('goal').placeholder;
    this.formPlaceholder = this.$('formInstruction').placeholder;
    // Each tab shows its own conversation in the Assistant card: what it shows is kept per tab, and a
    // running task writes to its own tab even when another tab is open (see viewTab).
    const start = modelChoices().length ? READY : '**To start, add a model** in Settings (⚙) → Models: a model on this computer with **Ollama** or **LM Studio** (free, nothing leaves your computer), or any OpenAI-compatible API.';
    this.views = Object.fromEntries(TABS.map((t) => [t, { output: start, status: '', sources: [], handle: null, meter: null, meterText: '', hasLog: false }]));
    this.convs = Object.fromEntries(TABS.map((t) => [t, null])); // { id, type, createdAt, url, title, turns, question, data } (agentChat is convs.chat)
    this.tab = 'chat';
    this.taskTab = null;         // the tab of the running task
    this.renderHistory();
    this.wire();
    this.root.querySelector('.tabs button.active')?.click(); // puts the Assistant card where the open tab wants it
  }

  $(id) { return this.root.querySelector(`#${id}`); }
  page() { return PageHandle.forTab(this.tabId); }
  get agentChat() { return this.convs.chat; }
  set agentChat(c) { this.convs.chat = c; }

  // ----- Output helpers -----
  /** The tab the output goes to: the running task's, else the open one. */
  get viewTab() { return this.taskTab || this.tab; }
  get outputText() { return this.views[this.viewTab].output; }
  get meter() { return this.views[this.viewTab].meter; }
  set meter(m) { this.views[this.viewTab].meter = m; }
  /** The answer area shows Markdown (headings, lists, tables…); the view keeps the text as written. */
  setOutput(text) {
    const tab = this.viewTab;
    this.views[tab].output = String(text ?? '');
    if (tab === this.tab) renderMarkdown(this.$('output'), this.views[tab].output);
  }
  setStatus(text) {
    const tab = this.viewTab;
    this.views[tab].status = text || '';
    if (tab === this.tab) this.$('status').textContent = text || '';
  }
  statusText() { return this.views[this.viewTab].status; }
  setSources(sources, handle) {
    const tab = this.viewTab;
    Object.assign(this.views[tab], { sources: sources || [], handle });
    if (tab === this.tab) this.renderSources();
  }
  /** Shows the open tab's conversation in the Assistant card. */
  renderView() {
    const v = this.views[this.tab];
    renderMarkdown(this.$('output'), v.output);
    this.$('status').textContent = v.status;
    this.renderSources();
    this.renderMeter(this.tab);
    this.$('exportChat').classList.toggle('hidden', !this.convs[this.tab]?.saved);
    this.$('downloadLog').classList.toggle('hidden', !v.hasLog);
  }
  setHasLog(tab, has) {
    this.views[tab].hasLog = has;
    if (tab === this.tab) this.$('downloadLog').classList.toggle('hidden', !has);
  }
  renderSources() {
    const { sources, handle } = this.views[this.tab];
    this.$('sources').replaceChildren(...sources.map((s) => {
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
      if (!b.closest('#confirmBox') && !b.closest('#hitNav') && !b.closest('#agentTalk') && !b.matches('#stop, #stopTask, #pauseTask, #copy, .steps-order')) b.disabled = busy;
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
    this.taskTab = this.tab; // its output, meter and conversation stay with this tab
    const tab = this.taskTab;
    this.notePage(this.url, this.title);
    bindModel(controller.signal, this.model);
    bindReasoning(controller.signal, this.reasoning);
    this.setBusy(true);
    renderGlobalBusy();
    // Time, and for API models requests, tokens and cost, shown live under the status line.
    this.lastMeter = this.views[tab].meterText; // of the previous run (kept with the turn it belongs to)
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
        const chat = tab === 'chat' && this.agentChat ? { chat: this.agentChat.id, turn: this.agentChat.turns.length } : {};
        this.modelLog.push({ ...c, message: tab === 'chat' ? message : this.convs[tab]?.question || '', tab, ...chat });
        if (this.modelLog.length > 500) this.modelLog.shift();
        this.setHasLog(tab, true);
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
      this.taskTab = null;
      renderGlobalBusy();
    }
  }

  /** The time and cost of the tab's last run (a saved turn's, when opened from the history). */
  renderMeter(tab = this.viewTab) {
    const v = this.views[tab];
    if (v.meter) v.meterText = meterText(v.meter);
    if (tab !== this.tab) return;
    const el = this.$('meter');
    el.textContent = v.meterText;
    el.classList.toggle('hidden', !v.meterText);
  }

  // ----- Conversations (the same in every tab) -----
  part(tab, name) { return this.root.querySelector(`.panel[data-panel="${tab}"] [data-conv="${name}"]`); }
  /**
   * A new question in a tab: the turn before it goes to the folded list of earlier turns, and the
   * first one starts the conversation (one history entry, continued by every follow-up).
   */
  beginTurn(tab, question) {
    let c = this.convs[tab];
    if (c?.question != null) this.archiveTurn(tab, this.turnOf(tab, this.lastMeter));
    c ||= this.convs[tab] = { id: newHistoryId(), type: tab, createdAt: Date.now(), url: this.url, title: '', turns: [], data: {} };
    c.question = question;
    c.answer = null; // set when the saved answer differs from what the card shows (Form: the values)
    this.showQuestion(tab, question);
    this.setSources([]);
    this.setOutput('');
    return c;
  }
  /** The open turn of a tab as data: shown in the earlier turns and saved with the conversation. */
  turnOf(tab, meter = this.views[tab].meterText) {
    const c = this.convs[tab];
    return { question: c.question, answer: c.answer ?? this.views[tab].output, ...(meter ? { meter } : {}) };
  }
  /** Adds a finished turn to the folded list of earlier turns (newest first, under the current answer). */
  archiveTurn(tab, turn) {
    const c = this.convs[tab];
    const index = c.turns.length;
    c.turns.push(turn);
    const el = turnElement(turn, index + 1);
    this.part(tab, 'list').prepend(el);
    this.showEarlier(tab);
    return { el, index };
  }
  showQuestion(tab, question) {
    const el = this.part(tab, 'q');
    renderMarkdown(el, question || '');
    el.classList.toggle('hidden', !question);
  }
  showEarlier(tab) {
    const n = this.part(tab, 'list').children.length;
    this.part(tab, 'earlier').classList.toggle('hidden', !n);
    this.part(tab, 'earlier').querySelector('.count').textContent = n ? `(${n})` : '';
  }
  /** Saves the tab's conversation as one history entry (with the attached files, where the tab uses them). */
  async saveConv(tab, extra = {}) {
    const c = this.convs[tab];
    if (!c) return;
    const files = FILE_TABS.has(tab) ? this.attachments.saved() : [];
    c.saved = true;
    await this.remember({ type: c.type, id: c.id, createdAt: c.createdAt, url: c.url || this.url || '', title: c.title || c.turns[0]?.question || c.question,
      turns: [...c.turns, this.turnOf(tab)], ...(Object.keys(c.data).length ? { data: c.data } : {}), ...(files.length ? { files } : {}), ...extra });
    if (tab === this.tab) this.$('exportChat').classList.remove('hidden');
  }
  /** Forgets the tab's conversation (it stays in the history): the next question starts a new one. */
  newConversation(tab = this.tab) {
    if (this.controller) return;
    if (tab === 'chat') this.resetAgentUI();
    this.convs[tab] = null;
    this.part(tab, 'list').replaceChildren();
    this.showEarlier(tab);
    this.showQuestion(tab, '');
    Object.assign(this.views[tab], { output: 'Ready.', status: '', sources: [], handle: null, meter: null, meterText: '', hasLog: false });
    if (tab === 'form') { this.pendingFill = null; this.$('fillPreview').classList.add('hidden'); this.showFormMode(); }
    if (tab === 'summarize') this.$('summaryAsk').value = '';
    if (tab === this.tab) this.renderView();
    this.renderHistory();
  }
  /** Shows a saved conversation in its tab; the next question continues it. */
  openConversation(tab, e) {
    const c = this.convs[tab] = { id: e.id, type: tab, createdAt: e.createdAt, url: e.url, title: e.title, turns: [], data: { ...(e.data || {}) }, saved: true };
    if (FILE_TABS.has(tab)) this.attachments.restore(e.files);
    for (const t of e.turns.slice(0, -1)) this.archiveTurn(tab, t);
    const last = e.turns.at(-1) || { question: e.title, answer: '' };
    c.question = last.question;
    this.showQuestion(tab, last.question);
    Object.assign(this.views[tab], { output: last.answer || '', meter: null, meterText: last.meter || '', sources: [], handle: null });
    if (tab === this.tab) this.renderView();
    return c;
  }

  // ----- Features -----
  /** Text of a file the user attached, shaped like an extracted page. */
  fileAsPage(id) {
    const a = this.attachments.get(id);
    if (!a) throw new Error('That attachment was removed.');
    return { title: a.name, url: '', meta: '', blocks: a.blocks };
  }

  /** The source of a summary conversation: the page, or an attached file (found by its name after a reload). */
  async summarySourcePage(source) {
    if (source.file) {
      const a = this.attachments.list().find((x) => x.name === source.file);
      if (!a) throw new Error(`“${source.file}” is not attached any more. Attach it again (📎), or start a new summary.`);
      return this.fileAsPage(a.id);
    }
    this.setStatus('Reading page…');
    return (await this.page()).call('extract');
  }
  /**
   * Summarize: the first summary of the conversation, or another one (other source or length); the
   * text in the box, if any, says what to focus on. A turn of the conversation each time.
   */
  async doSummarize(signal) {
    const sel = this.$('summarySource');
    const focus = this.$('summaryAsk').value.trim();
    const source = sel.value === 'page' ? { page: true } : { file: this.attachments.get(sel.value)?.name };
    const label = sel.value === 'page' ? `“${this.title || 'this page'}”` : `📎 ${source.file}`;
    const c = this.beginTurn('summarize', `Summary (${settings.summaryLength}) of ${label}${focus ? `: ${focus}` : ''}`);
    this.$('summaryAsk').value = '';
    const page = await this.summarySourcePage(source);
    c.data = { source };
    c.title ||= page.title || 'Summary';
    const text = await summarizePage({
      page, length: settings.summaryLength, lang: settings.lang, focus, signal,
      onStatus: (t) => this.setStatus(t), onText: (t) => { this.setStatus('Writing summary…'); this.setOutput(t); }
    });
    this.setOutput(text || 'No summary was generated.');
    this.setStatus(`Summary of “${page.title}”. Ask a follow-up below (“shorter”, “in German”, a question…).`);
    if (text) await this.saveConv('summarize');
  }
  /** A follow-up to the summary: builds on the last answer and the parts of the source it is about. */
  async doSummaryFollowUp(signal) {
    const text = this.$('summaryAsk').value.trim();
    const c = this.convs.summarize;
    if (!c?.data?.source) return this.doSummarize(signal); // nothing to follow up yet: a summary, focused on the text
    if (!text) { this.setStatus('Type a follow-up: “shorter”, “in German”, “more about the prices”, or a question.'); return; }
    const previous = this.views.summarize.output;
    const earlier = [...c.turns];
    let page = null;
    try { page = await this.summarySourcePage(c.data.source); } catch (e) { this.setStatus(`${e.message} Answering from the summary only.`); }
    this.beginTurn('summarize', text);
    this.$('summaryAsk').value = '';
    const excerpts = page ? relevantPassages({ page, question: `${text}\n${previous.slice(0, 500)}`, maxChars: 3500, maxPassages: 8 }).context : '';
    this.setStatus('Writing…');
    const answer = await followUpSummary({ request: text, previous, earlier, excerpts, title: page?.title || c.title, lang: settings.lang, signal,
      onText: (t) => this.setOutput(t) });
    this.setOutput(answer || 'No answer was generated.');
    this.setStatus('');
    if (answer) await this.saveConv('summarize');
  }

  showHits(res) {
    const has = res.total > 0;
    this.$('hitNav').classList.toggle('hidden', !has);
    this.$('hitCount').textContent = has ? `${res.index + 1} / ${res.total}` : '';
  }
  /** Search: each query is a turn of the tab's search conversation (no model, unless it searches by meaning). */
  async doSearch(signal) {
    const query = this.$('searchQuery').value.trim();
    if (!query) { this.setStatus('Type what you are looking for.'); return; }
    const handle = await this.page();
    this.searchHandle = handle;
    const c = this.beginTurn('search', query);
    c.title ||= query;
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
    await this.saveConv('search');
  }

  /** Form request so far: the first instruction and the follow-ups that asked to fill it all again. */
  formRequest() { return this.convs.form?.data?.instruction || ''; }
  /** Before the first scan the box takes the instruction; after it, follow-ups (Enter sends them). */
  showFormMode() {
    const started = !!this.pendingFill || !!this.convs.form;
    this.$('formInstruction').placeholder = started ? 'Ask for a change, e.g. “also fill Skills” or “use another project” (Enter to send)' : this.formPlaceholder;
    this.$('refineFill').classList.toggle('hidden', !this.pendingFill);
    this.$('prepareFill').textContent = started ? 'Scan form again' : 'Scan form & prepare values';
  }
  /**
   * Scans the form and prepares values for all of it: the first turn of a form conversation, or a later
   * one (another item, the form again after a change on the page). `typed` adds to the request so far.
   */
  async doPrepareFill(signal, typed = this.$('formInstruction').value.trim()) {
    const handle = await this.page();
    const instruction = [this.formRequest(), typed].filter(Boolean).join('\n');
    const c = this.beginTurn('form', typed || (this.convs.form?.turns.length || this.convs.form?.question ? 'Scan the form again' : 'Fill the form'));
    this.$('formInstruction').value = '';
    c.data = { instruction };
    let host = ''; try { host = new URL(this.url).hostname.replace(/^www\./, ''); } catch { /* not a web page */ }
    c.title ||= instruction.trim() || `Form on ${host || 'a page'}`;
    this.setStatus('Scanning form fields…');
    const fields = await handle.call('listFields');
    if (!fields.length) { this.setStatus(''); this.setOutput('No fillable form fields were found on this page.'); return; }
    const profile = settings.profile;
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
      await this.saveConv('form');
      return;
    }
    this.pendingFill = { handle, items, instruction, choice: proposals.choice };
    this.renderFillRows();
    this.showFormMode();
    const parts = [`Prepared ${proposals.length} of ${fields.length} field(s)`,
      clears.length && `${clears.length} filled field(s) without a suggestion will be cleared`,
      adds.length && `${adds.reduce((n, a) => n + a.values.length, 0)} item(s) to add with ${adds.map((a) => `“${addName(a.adder)}”`).join(', ')}`].filter(Boolean);
    this.setOutput(`${about}${parts.join('; ')}. Review and edit the values, then click “Apply selected”. Nothing has been entered yet.${failed}`);
    c.answer = `${about}Values prepared for ${proposals.length} of ${fields.length} field(s):\n\n` +
      `${proposals.map((p) => `${fieldName(p.field)}: ${p.value}`).join('\n')}` +
      `${adds.map((a) => `\n${addName(a.adder)}: ${a.values.join(', ')}`).join('')}${failed}`;
    await this.saveConv('form');
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

  /**
   * A follow-up to the prepared values ("also fill Skills"): fills the fields and "Add" buttons it is about,
   * keeping the other rows as the user left them. Asking for another item fills the whole form again.
   */
  async doRefineFill(signal) {
    const pending = this.pendingFill;
    const text = this.$('formInstruction').value.trim();
    if (!pending) return this.doPrepareFill(signal); // no values prepared (none yet, or applied): fill the form
    if (!text) { this.setStatus('Type what to change, e.g. “also fill Skills”, or click “Scan form again”.'); return; }
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
    // Another item, or everything again: the whole form, with the follow-up added to the request.
    if (t.redo) return this.doPrepareFill(signal, text);
    this.beginTurn('form', text);
    this.$('formInstruction').value = '';
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
    this.renderFillRows();
    const out = [changed.length ? `Updated:\n${changed.map((c) => `• ${c}`).join('\n')}` : 'Nothing new was found.',
      missing.length && `Nothing found in your info for: ${missing.map((m) => `“${m}”`).join(', ')}. Type the values in their rows, or say in a follow-up where they are (for example which section of your CV).`,
      'The other rows are as you left them. Review, then click “Apply selected”.'].filter(Boolean).join('\n\n');
    this.setOutput(out);
    await this.saveConv('form');
  }

  async doApplyFill() {
    const pending = this.pendingFill;
    if (!pending) return;
    this.syncFillRows();
    this.beginTurn('form', 'Apply the selected values');
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
    this.showFormMode();
    await this.saveConv('form');
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
    // Only for actions that need confirmation (submit, save, delete…), not for the other questions.
    this.$('confirmAllow').classList.toggle('hidden', !risky);
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
  /** The step limit from the panel (3–300); the box shows the value used, so a cap is never silent. */
  stepLimit(quiet = false) {
    const box = this.$('maxSteps');
    const n = Math.min(300, Math.max(3, Math.round(Number(box.value)) || settings.maxSteps || 25));
    if (!quiet || document.activeElement !== box) box.value = String(n); // not while the user is typing in it
    if (n !== settings.maxSteps) save('maxSteps', n);
    return n;
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
    if (!text) { this.setStatus(this.agentChat ? 'Type your message.' : 'Ask about this page, or say what should be done.'); return; }
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
    this.agentChat = chat || { id: newHistoryId(), type: 'chat', createdAt: Date.now(), url: this.url, title: '', turns: [], data: {} };
    this.agentChat.question = text;
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
      maxSteps: this.stepLimit(), liveMaxSteps: () => this.stepLimit(true),
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
      if (now?.url === tab.url) { this.setStatus(`${this.statusText()} Sources (click to highlight in page):`); this.setSources(citedSources(res.answer, sources), handle); }
    }
    return res.memory;
  }
  /** The current turn as data: shown in the history and saved with the conversation. */
  currentTurn(meter, interrupted = false) {
    const { plan = [], notes = [], results = [] } = this.agentChat?.memory?.state || {};
    const answer = interrupted
      ? 'The agent stopped before it finished (the panel was closed or reloaded, or it was stopped). Its steps, plan, notes and results so far are kept: send a message (for example “continue”) to go on from there.'
      : this.outputText;
    return { question: this.agentQuestion, answer, steps: [...this.turnSteps], meter,
      ...(plan.length || notes.length || results.length ? { state: structuredClone({ plan, notes, results }) } : {}) };
  }
  /** Saves the chat; while the agent works (interrupted = true), its progress after each step. The saves run
   *  one after another, so a slow save of the progress never overwrites the finished turn. */
  saveAgentChat(interrupted = false) {
    const c = this.agentChat;
    c.saved = true;
    const entry = { type: 'chat', id: c.id, title: c.turns[0]?.question || this.agentQuestion, url: c.url, createdAt: c.createdAt,
      turns: [...c.turns, this.currentTurn(this.views.chat.meterText, interrupted)], ...(c.memory ? { memory: c.memory } : {}),
      files: this.attachments.saved() };
    this.chatSaving = (this.chatSaving || Promise.resolve()).then(() => this.remember(entry));
    if (this.tab === 'chat') this.$('exportChat').classList.remove('hidden');
    return this.chatSaving;
  }

  // ----- History -----
  /** Saves an entry in the history (a failure to save is shown, but does not fail the task). */
  async remember(entry) {
    const { restored, ...rest } = entry;
    if (this.pages.length) rest.pages = this.pages.map(({ url, title }) => ({ url, title }));
    try { await saveHistory(rest); } catch (e) { this.setStatus(`${this.statusText()} Not saved in the history: ${e?.message || e}`); }
    this.renderHistory();
  }
  /** The history, newest first, above the tabs. */
  async renderHistory() {
    const entries = await listHistory();
    this.$('historyCount').textContent = entries.length ? `(${entries.length})` : '';
    const openIds = new Set(TABS.map((t) => this.convs[t]?.id).filter(Boolean));
    this.$('historyList').replaceChildren(...entries.map((e) => {
      const li = document.createElement('li');
      if (openIds.has(e.id)) li.className = 'open';
      const title = Object.assign(document.createElement('button'), { className: 'entry-title',
        title: 'Open it in its tab and continue it' });
      title.append(Object.assign(document.createElement('span'), { className: 'kind', textContent: HISTORY_TYPES[e.type] || e.type }),
        Object.assign(document.createElement('span'), { textContent: e.title, dir: 'auto' }));
      title.addEventListener('click', () => this.openHistory(e));
      let host = ''; try { host = new URL(e.url).hostname.replace(/^www\./, ''); } catch { /* no page */ }
      const n = e.turns.length;
      const meta = Object.assign(document.createElement('div'), { className: 'hint',
        textContent: [host, new Date(e.updatedAt).toLocaleString(), n > 1 ? `${n} questions` : ''].filter(Boolean).join(' · ') });
      const del = Object.assign(document.createElement('button'), { className: 'text-button', textContent: 'Delete' });
      del.addEventListener('click', async () => {
        const what = `${HISTORY_TYPES[e.type] || e.type}: “${clip(e.title, 80)}${Array.from(e.title || '').length > 80 ? '…' : ''}”`;
        if (!confirm(`Delete this entry from the history?\n\n${what}${n > 1 ? ` (${n} questions)` : ''}\n\nThis cannot be undone.`)) return;
        await deleteHistory(e.id); this.renderHistory();
      });
      const exp = Object.assign(document.createElement('button'), { className: 'text-button', textContent: 'Export',
        title: 'Save this entry as a JSON file (with the model log, when it is the chat open here and a log was kept)' });
      exp.addEventListener('click', () => {
        const tab = TABS.find((t) => this.convs[t]?.id === e.id);
        exportEntry(e, tab ? this.modelLog.filter((x) => (x.tab || 'chat') === tab) : []); downloaded(exp);
      });
      meta.append(' ', exp, ' ', del);
      li.append(title, meta);
      return li;
    }));
  }
  showTab(name) { this.root.querySelector(`.tabs button[data-tab="${name}"]`).click(); }
  /** Opens a history entry in its tab: the conversation continues with the next question there. */
  openHistory(e) {
    if (this.controller) return;
    const tab = TAB_OF_TYPE[e.type];
    if (!tab) return;
    this.$('historyBox').open = false;
    this.showTab(tab);
    this.newConversation(tab);
    const when = new Date(e.updatedAt).toLocaleString();
    this.mergePages(e.pages || (e.url ? [{ url: e.url, title: CHAT_TYPES.has(e.type) ? '' : e.title }] : []));
    if (tab === 'chat') { this.openAgentChat(e); this.renderHistory(); return; }
    this.openConversation(tab, e);
    const files = FILE_TABS.has(tab) ? filesNote(e.files) : '';
    const next = {
      summarize: 'Ask a follow-up below, or click Summarize for a new summary in this conversation.',
      search: 'Search again to run a query on this page.',
      form: 'Open the form and click “Scan form again” to fill it with the same request, or type what to change.'
    }[tab];
    if (tab === 'form') this.showFormMode();
    this.setStatus(`Saved from ${when}.${files} ${next}`);
    this.renderHistory();
  }
  /** Shows a saved agent conversation in this tab; the next question continues it. */
  openAgentChat(c) {
    this.resetAgentUI();
    this.agentChat = { id: c.id, type: 'chat', createdAt: c.createdAt, url: c.url, title: c.title, turns: [], data: {}, saved: true, ...(c.memory ? { memory: c.memory } : {}) };
    this.attachments.restore(c.files); // the files attached in this chat, attached again
    for (const t of c.turns.slice(0, -1)) this.archiveAgentTurn(t);
    const last = c.turns.at(-1);
    this.showAgentChat(last?.question || '');
    this.agentChat.question = last?.question || '';
    this.setOutput(last?.answer || '');
    for (const step of last?.steps || []) this.log(step);
    this.views.chat.meterText = last?.meter || '';
    this.renderMeter('chat');
    const { plan = [], notes = [], results = [] } = c.memory?.state || {};
    this.agentEvent({ type: 'plan', plan }); this.agentEvent({ type: 'notes', notes }); this.agentEvent({ type: 'results', results });
    this.foldAgentBoxes(true); // a saved conversation opens with its answer; the details are one click away
    this.$('exportChat').classList.remove('hidden');
    this.setStatus(`Saved conversation from ${new Date(c.updatedAt).toLocaleString()}.${filesNote(c.files)} Type a follow-up in the box above to continue it.`);
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
    this.modelLog = this.modelLog.filter((x) => x.tab && x.tab !== 'chat'); // the other tabs keep theirs
    this.setHasLog('chat', false);
    if (this.tab === 'chat') this.$('exportChat').classList.add('hidden');
    this.turnBase = null;
    this.$('agentPlanBox').classList.remove('stale');
    for (const c of this.root.querySelectorAll('.agent-box > summary > .count:not(#agentStepCount)')) c.textContent = '';
    this.agentChat = null;
    this.turnSteps = [];
    this.part('chat', 'list').replaceChildren();
    this.showAgentChat('');
  }
  /** The question of the current turn above its answer, and the box as "ask a follow-up". */
  showAgentChat(question) {
    if (question != null) {
      this.agentQuestion = question;
      this.showQuestion('chat', question);
    }
    this.showEarlier('chat');
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
    const { el, index } = this.archiveTurn('chat', turn);
    if (this.turnCalls(index).length) {
      const btn = Object.assign(document.createElement('button'), { className: 'text-button small', textContent: 'Download model log',
        title: 'The requests sent to the model for this question, and its replies, exactly as they were, as a text file' });
      btn.addEventListener('click', () => { this.downloadModelLog(index); downloaded(btn); });
      el.querySelector('.turn-tools').append(btn);
    }
    this.setHasLog('chat', false); // until the new question's first request
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
    if (this.tab !== 'chat' || !c) { downloadFile(`model-log-${this.tab}-${stamp()}.txt`, formatModelLog(this.modelLog.filter((x) => !x.chat && (x.tab || 'chat') === this.tab), { title: this.title, url: this.url }), type); return; }
    const calls = this.turnCalls(index);
    const before = index > 0 ? this.turnCalls(index - 1).at(-1) : null;
    const question = index < c.turns.length ? c.turns[index].question : this.agentQuestion;
    const title = c.turns[0]?.question || this.agentQuestion;
    downloadFile(`${fileStem('chat', title)}-q${index + 1}-model-log.txt`,
      formatModelLog(calls, { title, url: c.url || this.url, question, number: index + 1, before }), type);
  }
  /** Saves the open tab's conversation, as it is in the history, as a JSON file (with its model log, if kept). */
  async exportChat() {
    const id = this.convs[this.tab]?.id;
    const entry = id && (await listHistory()).find((e) => e.id === id);
    if (!entry) { this.setStatus('This conversation is not in the history yet: export it after the answer.'); flash(this.$('exportChat'), 'Not yet', { ok: false }); return; }
    exportEntry(entry, this.modelLog.filter((x) => (x.tab || 'chat') === this.tab));
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
      case 'checkpoint': if (this.agentChat) { this.agentChat.memory = e.memory; this.saveAgentChat(true); } break;
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
        this.setStatus(`Attached “${a.name}” (${a.kind}${a.pages ? `, ${a.pages} page${a.pages > 1 ? 's' : ''}` : ''}). Chat and Form use it, and Summarize can summarize it.`);
      } catch (e) {
        this.setStatus(`Could not read “${file.name}”: ${e.message}`);
      }
    }
  }

  // ----- Wiring -----
  wire() {
    const on = (id, type, fn) => this.$(id).addEventListener(type, fn);
    const run = (fn, opts) => () => this.run(fn, opts);

    this.root.querySelectorAll('.tabs button').forEach((tab) => tab.addEventListener('click', () => {
      this.root.querySelectorAll('.tabs button').forEach((t) => t.classList.toggle('active', t === tab));
      this.root.querySelectorAll('.panel').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== tab.dataset.tab));
      // The Assistant card (status, time/cost, answer) goes under the tab's current question, and shows its conversation.
      this.tab = tab.dataset.tab;
      this.part(this.tab, 'slot').append(this.$('assistantCard'));
      this.renderView();
    }));
    this.attachments.onChange((list) => {
      this.renderAttachments(list);
      // A file attached or removed in the open tab's saved conversation: saved with it now (during a run, at its end).
      const c = this.convs[this.tab];
      if (c?.saved && FILE_TABS.has(this.tab) && !this.controller) patchHistory(c.id, { files: this.attachments.saved() }).catch(() => {});
    });
    on('fileInput', 'change', (e) => { this.attachFiles([...e.target.files]); e.target.value = ''; });

    // Settings that live inside the session markup are still global: sync them on show().
    on('summaryLength', 'change', (e) => save('summaryLength', e.target.value));
    on('confirmAll', 'change', (e) => save('confirmAll', e.target.checked));
    on('profile', 'input', (e) => save('profile', e.target.value));

    on('summarize', 'click', run(this.doSummarize));
    on('summaryFollow', 'click', run(this.doSummaryFollowUp));
    on('summaryAsk', 'keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.run(this.doSummaryFollowUp); } });
    on('search', 'click', run(this.doSearch, { needsModel: false }));
    on('searchQuery', 'keydown', (e) => { if (e.key === 'Enter') this.run(this.doSearch, { needsModel: false }); });
    on('prevHit', 'click', () => this.searchHandle?.call('moveHit', -1).then((r) => this.showHits(r)).catch((e) => this.showError(e)));
    on('nextHit', 'click', () => this.searchHandle?.call('moveHit', 1).then((r) => this.showHits(r)).catch((e) => this.showError(e)));
    on('clearHits', 'click', () => { this.searchHandle?.call('clearHighlights').catch(() => {}); this.$('hitNav').classList.add('hidden'); });
    on('prepareFill', 'click', () => this.run((signal) => this.doPrepareFill(signal)));
    on('applyFill', 'click', run(this.doApplyFill, { needsModel: false }));
    on('refineFill', 'click', run(this.doRefineFill));
    // Enter in the Form box: a follow-up to the prepared values, or (none yet) the scan.
    on('formInstruction', 'keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.run(this.doRefineFill); } });
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
    on('newTask', 'click', () => { if (!this.controller) { this.newConversation('chat'); this.$('goal').focus(); } });
    on('goal', 'keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.$('runTask').click(); } });
    on('agentReply', 'keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.sendToAgent(); } });
    on('confirmRun', 'click', () => this.hideConfirm('run'));
    on('confirmSkip', 'click', () => this.hideConfirm('skip'));
    on('confirmStop', 'click', () => this.hideConfirm('stop'));
    on('confirmAllow', 'click', () => this.hideConfirm('all'));

    on('stop', 'click', () => this.controller?.abort());
    on('stopTask', 'click', () => this.controller?.abort());
    on('pauseTask', 'click', () => this.togglePause());
    on('copy', 'click', () => {
      const button = this.$('copy');
      const text = this.views[this.tab].output;
      if (!text.trim()) { flash(button, 'Nothing to copy', { ok: false }); return; }
      navigator.clipboard.writeText(text).then(() => flash(button, '✓ Copied'),
        (e) => { flash(button, '✗ Not copied', { ok: false }); this.setStatus(`Could not copy: ${e.message || e}`); });
    });
    on('clear', 'click', () => this.newConversation(this.tab)); // "New": this tab starts a new conversation
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

/** Steps newest first (the default) or oldest first: one choice for every step list, kept in this browser. */
function applyStepsOrder(toggle = false) {
  let newest = true;
  try { newest = localStorage.getItem('stepsOrder') !== 'oldest'; } catch { /* storage blocked: the default */ }
  if (toggle) {
    newest = !newest;
    try { localStorage.setItem('stepsOrder', newest ? 'newest' : 'oldest'); } catch { /* not kept */ }
  }
  document.body.classList.toggle('steps-newest', newest);
  for (const b of document.querySelectorAll('.steps-order')) b.textContent = newest ? '↑↓ Newest first' : '↑↓ Oldest first';
}
applyStepsOrder();
// One listener for every panel (each tab's panel is a copy of the same markup).
document.addEventListener('click', (e) => {
  if (!e.target.closest?.('.steps-order')) return;
  e.preventDefault(); e.stopPropagation(); // a button in the summary: do not fold the box
  applyStepsOrder(true);
}, true);

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
// The step limit is kept for every tab and after a reload (each tab's panel has its own box).
// Saved as the user types: the panel may be closed before the box loses focus (when "change" fires).
document.addEventListener('input', (e) => {
  if (e.target.id !== 'maxSteps') return;
  const n = Math.round(Number(e.target.value));
  if (n >= 3 && n <= 300 && n !== settings.maxSteps) save('maxSteps', n);
}, true);
document.addEventListener('change', (e) => { if (e.target.id === 'maxSteps') shown?.stepLimit(); }, true);
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
