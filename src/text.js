// Text utilities: Unicode-aware normalization, language selection, chunking, BM25 retrieval and JSON repair.

// ---------- Normalization (keep normChar in sync with public/content.js) ----------
const SPACE_RE = /\s/;
const MARK_RE = /\p{M}/u;     // combining marks (accents in decomposed text)
const FORMAT_RE = /\p{Cf}/u;  // invisible format characters (zero-width joiners, soft hyphen, …)
const DIGIT_RE = /\p{Nd}/u;
const MARKS_ONLY_RE = /^\p{M}+$/u;
const digitCache = new Map();

/** ASCII value of a decimal digit from any script ("३", "３", "๓" → "3"). */
export function digitValue(c) {
  let v = digitCache.get(c);
  if (v === undefined) {
    const cp = c.codePointAt(0);
    let zero = cp; // Unicode digit runs are contiguous and start at zero
    while (zero > 0 && DIGIT_RE.test(String.fromCodePoint(zero - 1)) && cp - zero < 9) zero--;
    v = String(cp - zero);
    digitCache.set(c, v);
  }
  return v;
}

/** One UTF-16 unit → '' or one character: lower-case, accents removed, digits as ASCII, spaces unified. */
export function normChar(c) {
  if (SPACE_RE.test(c)) return ' ';
  if (MARK_RE.test(c) || FORMAT_RE.test(c)) return '';
  if (c >= '0' && c <= '9') return c;
  if (DIGIT_RE.test(c)) return digitValue(c);
  const d = c.normalize('NFD');
  const base = d.length > 1 && MARKS_ONLY_RE.test(d.slice(1)) ? d[0] : c; // é → e, ü → u
  const lower = base.toLowerCase();
  return lower.length === 1 ? lower : base;
}

/** Same normalization as public/content.js, so quotes can be located in the page. */
export function normalize(s) {
  const str = String(s || '');
  let out = '';
  for (let i = 0; i < str.length; i++) { // per UTF-16 unit, exactly like the page index
    const n = normChar(str[i]);
    if (n === ' ' && (out === '' || out.endsWith(' '))) continue;
    out += n;
  }
  return out.trim();
}

/**
 * Prepare text for the model: digits from any script become ASCII digits.
 * Small models read and copy ASCII numbers far more reliably.
 */
export function forModel(s) {
  return String(s || '').replace(/\p{Nd}/gu, (d) => (d >= '0' && d <= '9' ? d : digitValue(d)));
}

// ---------- Output language ----------
/** Answer-language choices offered in Settings ("auto" follows the question or the page). */
export const LANGUAGE_CHOICES = ['auto', 'en', 'de', 'fr', 'es', 'it', 'nl', 'pt', 'pl'];

/** English name of a language code ("de" → "German"). */
export function languageName(code) {
  try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code; } catch { return code; }
}

/**
 * Name of the language the model should write in: the user's choice, or the language detected in
 * `sample` (Chrome's built-in detector). Returns null when it can't be determined reliably;
 * callers then ask for "the same language as …".
 */
export async function outputLanguage(choice, sample) {
  if (choice && choice !== 'auto') return languageName(choice);
  const text = String(sample || '').slice(0, 3000);
  try {
    const res = await chrome.i18n.detectLanguage(text);
    const top = res?.languages?.[0];
    if (top?.language && top.language !== 'und' && (res.isReliable || top.percentage >= 80)) {
      return languageName(top.language.split('-')[0]);
    }
  } catch { /* outside an extension page */ }
  return null;
}

const STOPWORDS = new Set((
  'the a an of to in on at for and or is are was were be been it this that these those with as by from what which who ' +
  'how when where why does do did can could would should about into than then there their its your you me my i we our ' +
  'page please tell find show me give'
).split(/\s+/));

/** Tokens for lexical retrieval. Adds a 5-char prefix as a crude, language-independent stemmer. */
export function tokenize(text) {
  const words = normalize(text).match(/[\p{L}\p{N}]+/gu) || [];
  const out = [];
  for (const w of words) {
    if (w.length < 2 || STOPWORDS.has(w)) continue;
    out.push(w);
    if (w.length > 5) out.push(`${w.slice(0, 5)}*`);
  }
  return out;
}

/**
 * Group consecutive page blocks into passages of roughly `maxChars`, carrying the nearest heading
 * as context so each passage stands on its own for retrieval.
 */
export function chunkBlocks(blocks, maxChars = 1200) {
  const passages = [];
  let cur = null;
  let heading = '';
  const flush = () => { if (cur?.text.trim()) passages.push(cur); cur = null; };
  for (const b of blocks) {
    if (b.heading) { flush(); heading = b.text.slice(0, 160); }
    if (cur && cur.text.length + b.text.length > maxChars) flush();
    if (!cur) cur = { id: passages.length, heading, blockIds: [], text: '' };
    // Split huge single blocks so one block can't blow the budget.
    if (b.text.length > maxChars) {
      for (let i = 0; i < b.text.length; i += maxChars) {
        if (cur?.text) flush();
        cur = { id: passages.length, heading, blockIds: [b.id], text: b.text.slice(i, i + maxChars) };
        flush();
      }
      continue;
    }
    cur.blockIds.push(b.id);
    cur.text += (cur.text ? '\n' : '') + b.text;
  }
  flush();
  passages.forEach((p, i) => { p.id = i; });
  return passages;
}

/** Okapi BM25 over passages. Returns passages sorted by score with `score` attached. */
export function bm25Rank(passages, query, { k1 = 1.4, b = 0.75, field = (p) => `${p.heading || ''} ${p.text}` } = {}) {
  const qTokens = [...new Set(tokenize(query))];
  const docs = passages.map((p) => tokenize(field(p)));
  const avgLen = docs.reduce((s, d) => s + d.length, 0) / Math.max(1, docs.length);
  const df = new Map();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) || 0) + 1);
  const N = docs.length;
  const nq = normalize(query);
  return passages.map((p, i) => {
    const tf = new Map();
    for (const t of docs[i]) tf.set(t, (tf.get(t) || 0) + 1);
    let score = 0;
    for (const t of qTokens) {
      const f = tf.get(t);
      if (!f) continue;
      const idf = Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5));
      score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * docs[i].length / (avgLen || 1)));
    }
    if (nq.length > 3 && normalize(p.text).includes(nq)) score += 5; // exact phrase bonus
    return { ...p, score };
  }).sort((x, y) => y.score - x.score);
}

/** Pick top-ranked passages until the character budget is spent, then restore document order. */
export function selectWithinBudget(ranked, maxChars, maxCount = 8) {
  const picked = [];
  let used = 0;
  for (const p of ranked) {
    if (picked.length >= maxCount) break;
    if (used + p.text.length > maxChars && picked.length) continue;
    picked.push(p);
    used += p.text.length;
  }
  return picked.sort((a, b) => a.id - b.id);
}

/** Extract the first JSON object/array from model output, tolerating code fences and trailing commas. */
export function extractJSON(raw) {
  const text = String(raw || '').replace(/```(?:json)?/gi, '').trim();
  const starts = [text.indexOf('{'), text.indexOf('[')].filter((i) => i >= 0);
  if (!starts.length) throw new Error('The model did not return JSON.');
  const start = Math.min(...starts);
  const stack = [];
  let out = '';
  let inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      out += c;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') stack.push('}');
    else if (c === '[') stack.push(']');
    else if (c === '}' || c === ']') {
      if (!stack.includes(c)) continue; // stray closer: drop it
      // Small models sometimes forget a closer, e.g. [{"id":1, "v":"x"]: insert the missing ones.
      while (stack.at(-1) !== c) out += stack.pop();
      stack.pop();
      out += c;
      if (!stack.length) return parseLoose(out);
      continue;
    }
    out += c;
  }
  // Output was cut off (max tokens): close the open string and brackets.
  try {
    return parseLoose(out.replace(/\\$/, '') + (inStr ? '"' : '') + [...stack].reverse().join(''));
  } catch (e) {
    // Truncated array whose last item is incomplete: keep only the complete items.
    const lastObj = out.lastIndexOf('}');
    if (out[0] === '[' && lastObj > 0) return parseLoose(`${out.slice(0, lastObj + 1)}]`);
    throw e;
  }
}

function parseLoose(s) {
  try { return JSON.parse(s); } catch { /* try repairs */ }
  const repaired = s
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/([{,]\s*)([A-Za-z_][\w]*)\s*:/g, '$1"$2":')
    .replace(/:\s*'([^']*)'/g, ': "$1"');
  return JSON.parse(repaired);
}

export function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}
