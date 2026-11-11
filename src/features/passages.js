import { bm25Rank, chunkBlocks, forModel } from '../text.js';

/**
 * The passages of the page and of the attached files most relevant to the question, numbered for citing.
 * The agent gets them with its first step, so a question they answer needs no tool call.
 * Returns { context, sources: [{ n, text, score, blockIds?, file? }] } (context: '' when there is nothing).
 */
export function relevantPassages({ page, filePassages = [], question, maxChars, maxPassages = 8, onStatus }) {
  const pagePassages = page ? chunkBlocks(page.blocks, 700) : [];
  // One ordered pool: page passages first (in document order), then files.
  const pool = [...pagePassages.map((p) => ({ ...p, origin: 'page' })), ...filePassages.map((p) => ({ ...p, origin: 'file' }))]
    .map((p, i) => ({ ...p, order: i }));
  onStatus?.('Finding relevant passages…');
  const ranked = pool.length ? bm25Rank(pool, question) : [];
  const picked = [];
  let used = 0;
  for (const p of ranked) {
    if (picked.length >= maxPassages) break;
    if (used + p.text.length > maxChars && picked.length) continue;
    picked.push(p);
    used += p.text.length;
  }
  picked.sort((a, b) => a.order - b.order);

  const label = (p) => (p.origin === 'file' ? ` (file: ${p.file})` : p.heading ? ` (${p.heading})` : '');
  const sources = picked.map((p, i) => ({ n: i + 1, text: p.text, score: p.score, blockIds: p.blockIds, file: p.file }));
  const context = [
    page?.selection ? `[selected by user] ${page.selection}` : '',
    page?.meta ? `[page metadata]\n${page.meta}` : '',
    ...picked.map((p, i) => `[${i + 1}]${label(p)}\n${p.text}`)
  ].filter(Boolean).map(forModel).join('\n\n');
  return { context, sources };
}

/** Only the cited sources if the answer cites any, else the best three. */
export function citedSources(answer, sources) {
  const cited = new Set([...String(answer || '').matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
  return cited.size ? sources.filter((s) => cited.has(s.n)) : [...sources].sort((a, b) => b.score - a.score).slice(0, 3);
}
