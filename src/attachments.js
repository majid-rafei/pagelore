// User-attached files: a general-purpose context source used by every feature
// (Ask, Summarize, Form, Actions). Each tab session has its own store, kept in memory only.
import { readDocument } from './documents.js';
import { bm25Rank, chunkBlocks } from './text.js';

let nextId = 1; // unique across stores

export function createAttachmentStore() {
  const items = []; // { id, name, kind, pages, text, blocks, passages }
  const listeners = new Set();

  const list = () => items.map(({ id, name, kind, pages, text }) => ({ id, name, kind, pages, chars: text.length }));
  const emit = () => listeners.forEach((fn) => fn(list()));

  /** Passages from all attachments, labelled with their file name. */
  const allPassages = () => items.flatMap((a) => a.passages.map((p) => ({ ...p, file: a.name })));

  /** Adds a document read from a file (or saved with a chat): { name, kind, text, pages? }. */
  function addDoc(doc) {
    const id = nextId++;
    // Paragraph-level pseudo-blocks so the same chunking/retrieval used for pages works for files.
    const blocks = doc.text.split(/\n+/).filter((t) => t.trim()).map((text, i) => ({
      id: `f${id}:${i}`, text: text.trim(), heading: 0
    }));
    const item = { id, ...doc, blocks, passages: chunkBlocks(blocks, 700) };
    items.push(item);
    emit();
    return item;
  }

  return {
    list,
    onChange: (fn) => listeners.add(fn),
    get: (id) => items.find((a) => a.id === Number(id)) || null,
    hasAttachments: () => items.length > 0,
    allPassages,
    /** Concatenated text of all attachments (for deterministic extraction such as emails/phones). */
    allText: () => items.map((a) => a.text).join('\n\n'),

    async addFile(file) {
      return addDoc(await readDocument(file));
    },

    /** The files as saved with a chat: the text read from them (not the files themselves). */
    saved: () => items.map(({ name, kind, pages, text }) => ({ name, kind, ...(pages ? { pages } : {}), text })),
    /** Attaches the saved files of a chat again (those not attached already). */
    restore(docs = []) {
      for (const d of docs) if (d?.text && !items.some((a) => a.name === d.name && a.text === d.text)) addDoc(d);
    },

    remove(id) {
      const i = items.findIndex((a) => a.id === Number(id));
      if (i >= 0) { items.splice(i, 1); emit(); }
    },

    /** The attachment passages most relevant to `query`, within a character budget. */
    relevantExcerpts(query, maxChars = 1500) {
      const passages = allPassages();
      // Short documents fit entirely: send everything. This also covers cross-language cases
      // (e.g. English form labels vs. a French document) where lexical ranking finds no overlap.
      if (passages.reduce((n, p) => n + p.text.length, 0) <= maxChars) return passages;
      const ranked = bm25Rank(passages, query).filter((p) => p.score > 0);
      const picked = [];
      let used = 0;
      for (const p of ranked) {
        if (used + p.text.length > maxChars) continue;
        picked.push(p);
        used += p.text.length;
      }
      return picked;
    }
  };
}
