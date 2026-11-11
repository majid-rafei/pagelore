// The history of the panel: chats, summaries, searches and form fills,
// so work is not lost when the browser closes. Each entry reopens in its own tab; chats
// can be continued (entries of type 'ask' and 'agent' are chats saved by older versions). Kept in chrome.storage.local (this browser only, never synced), newest first.

const KEY = 'history';
const MAX = 100; // older entries are dropped

export const HISTORY_TYPES = { chat: 'Chat', ask: 'Chat', agent: 'Chat', summarize: 'Summary', search: 'Search', form: 'Form' };

/**
 * @typedef {{ id: string, type: keyof HISTORY_TYPES, title: string, url: string, createdAt: number, updatedAt: number,
 *   turns: Array<{question: string, answer: string, steps?: Array<{type, text}>, meter?: string}>,
 *   memory?: object, data?: object, files?: Array<{name: string, kind: string, text: string, pages?: number}> }} HistoryEntry
 *   files: the files attached in a chat, as the text read from them (attached again when the chat is opened)
 * @returns {Promise<HistoryEntry[]>}
 */
export async function listHistory() {
  try { return (await chrome.storage.local.get(KEY))[KEY] || []; } catch { return []; }
}

// Every tab has its own panel, and each change reads the list and writes it back: a lock shared by all
// pages of the extension keeps two panels that save at the same time from losing each other's entries.
const locked = (fn) => (navigator.locks ? navigator.locks.request('history', fn) : fn());

/** Adds the entry, or replaces the one with the same id, and moves it to the top. */
export function saveHistory(entry) {
  return locked(async () => {
    const list = (await listHistory()).filter((e) => e.id !== entry.id);
    list.unshift({ ...entry, updatedAt: Date.now() });
    await chrome.storage.local.set({ [KEY]: list.slice(0, MAX) });
  });
}

/** Changes fields of a saved entry where it is (it does not move to the top). Returns false if there is no such entry. */
export function patchHistory(id, fields) {
  return locked(async () => {
    const list = await listHistory();
    const entry = list.find((e) => e.id === id);
    if (!entry) return false;
    Object.assign(entry, fields);
    await chrome.storage.local.set({ [KEY]: list });
    return true;
  });
}

export function deleteHistory(id) {
  return locked(async () => {
    await chrome.storage.local.set({ [KEY]: (await listHistory()).filter((e) => e.id !== id) });
  });
}

export const deleteAllHistory = () => locked(() => chrome.storage.local.remove(KEY));

export const newHistoryId = () => crypto.randomUUID();
