// A small Markdown renderer for the answers of the models.
//
// Model output can be steered by page content (untrusted), so it never goes through innerHTML:
// every element is created with createElement/textContent. Links work only with http(s) and mailto
// and open in a new tab; images are never loaded (a remote image URL could carry data out), they
// are shown as links. Supported: headings, paragraphs, line breaks, bold, italic, strikethrough,
// inline code, code blocks, block quotes, ordered / bulleted / task lists (nested), tables, rules.

const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const FENCE = /^\s*(```|~~~)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?/;
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };

/** Renders `text` into `target` (its children are replaced). */
export function renderMarkdown(target, text) {
  const frag = document.createDocumentFragment();
  blocks(String(text ?? '').replace(/\r\n?/g, '\n').split('\n'), frag);
  target.replaceChildren(frag);
}

function startsBlock(line, next) {
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || LIST_ITEM.test(line) ||
    (line.includes('|') && next != null && TABLE_SEP.test(next) && next.includes('-'));
}

function blocks(lines, parent) {
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    let m;
    if ((m = FENCE.exec(line))) {
      const fence = m[1];
      const code = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence); i++) code.push(lines[i]);
      i++; // the closing fence (missing while an answer is still streaming)
      const pre = el('pre'); const c = el('code'); c.textContent = code.join('\n'); pre.append(c); parent.append(pre);
      continue;
    }
    if ((m = HEADING.exec(line))) {
      const h = el(`h${m[1].length}`); inline(m[2], h); parent.append(h); i++;
      continue;
    }
    if (RULE.test(line)) { parent.append(el('hr')); i++; continue; }
    if (QUOTE.test(line)) {
      const inner = [];
      for (; i < lines.length && lines[i].trim() && (QUOTE.test(lines[i]) || !startsBlock(lines[i], lines[i + 1])); i++) inner.push(lines[i].replace(QUOTE, ''));
      const q = el('blockquote'); blocks(inner, q); parent.append(q);
      continue;
    }
    if (LIST_ITEM.test(line)) { i = list(lines, i, parent); continue; }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) { i = table(lines, i, parent); continue; }
    // Paragraph: single line breaks are kept (models use them for short lines).
    const p = el('p');
    for (let first = true; i < lines.length && lines[i].trim() && (first || !startsBlock(lines[i], lines[i + 1])); i++, first = false) {
      if (!first) p.append(el('br'));
      inline(lines[i].trim(), p);
    }
    parent.append(p);
  }
}

function list(lines, i, parent) {
  const stack = []; // { indent, ordered, el }
  let lastLi = null;
  while (i < lines.length) {
    const line = lines[i];
    const m = LIST_ITEM.exec(line);
    if (!m) {
      if (!line.trim()) {
        // A blank line ends the list unless another item follows.
        if (i + 1 < lines.length && LIST_ITEM.test(lines[i + 1])) { i++; continue; }
        break;
      }
      if (startsBlock(line, lines[i + 1]) && !/^\s+/.test(line)) break;
      // Continuation of the item above.
      lastLi.append(el('br')); inline(line.trim(), lastLi); i++;
      continue;
    }
    const indent = m[1].replace(/\t/g, '    ').length;
    const ordered = /\d/.test(m[2]);
    while (stack.length > 1 && stack.at(-1).indent > indent) stack.pop();
    let top = stack.at(-1);
    if (!top || indent > top.indent + 1) {
      const l = el(ordered ? 'ol' : 'ul');
      if (ordered && parseInt(m[2], 10) !== 1) l.start = parseInt(m[2], 10);
      (top && lastLi ? lastLi : parent).append(l);
      stack.push(top = { indent, ordered, el: l });
    } else if (top.ordered !== ordered) {
      const l = el(ordered ? 'ol' : 'ul');
      top.el.after(l);
      Object.assign(top, { ordered, el: l });
    }
    lastLi = el('li');
    let text = m[3];
    const task = /^\[([ xX])\]\s+/.exec(text);
    if (task) { lastLi.className = 'task'; lastLi.append(task[1] === ' ' ? '☐ ' : '☑ '); text = text.slice(task[0].length); }
    inline(text, lastLi);
    top.el.append(lastLi);
    i++;
  }
  return i;
}

function cells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

function table(lines, i, parent) {
  const align = cells(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : ''));
  const wrap = el('div', 'table-wrap');
  const t = el('table');
  const head = el('tr');
  cells(lines[i]).forEach((c, k) => { const th = el('th'); if (align[k]) th.style.textAlign = align[k]; inline(c, th); head.append(th); });
  const thead = el('thead'); thead.append(head);
  const tbody = el('tbody');
  for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) {
    const tr = el('tr');
    cells(lines[i]).forEach((c, k) => { const td = el('td'); if (align[k]) td.style.textAlign = align[k]; inline(c, td); tr.append(td); });
    tbody.append(tr);
  }
  t.append(thead, tbody); wrap.append(t); parent.append(wrap);
  return i;
}

const INLINE = [
  ['code', /`([^`\n]+)`/],
  ['image', /!\[([^\]\n]*)\]\(\s*<?((?:[^\s()<>]|\([^\s()<>]*\))+)>?(?:\s+"[^"]*")?\s*\)/],
  ['link', /\[([^\]\n]+)\]\(\s*<?((?:[^\s()<>]|\([^\s()<>]*\))+)>?(?:\s+"[^"]*")?\s*\)/],
  ['auto', /<?\b((?:https?:\/\/|mailto:)[^\s<>]*[^\s<>.,;:!?'")\]])>?/],
  ['strong', /\*\*(?=\S)([^\n]*?\S)\*\*|(?<!\w)__(?=\S)([^\n]*?\S)__(?!\w)/],
  ['del', /~~(?=\S)([^\n]*?\S)~~/],
  ['em', /\*(?=[^\s*])([^*\n]*?[^\s*])\*|(?<!\w)_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/],
];

/** http(s) and mailto only: other schemes (javascript:, data:, …) are shown as text. */
function safeUrl(url) {
  try {
    const u = new URL(url);
    return ['http:', 'https:', 'mailto:'].includes(u.protocol) ? u.href : null;
  } catch { return null; }
}

function link(href, label, parent) {
  const a = el('a');
  a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.title = href;
  if (typeof label === 'string') a.textContent = label; else inline(label.text, a);
  parent.append(a);
}

function inline(text, parent) {
  while (text) {
    let best = null;
    for (const [kind, re] of INLINE) {
      const m = re.exec(text);
      if (m && (!best || m.index < best.m.index)) best = { kind, m };
    }
    if (!best) { parent.append(text); return; }
    const { kind, m } = best;
    if (m.index) parent.append(text.slice(0, m.index));
    const inner = m[1] ?? m[2];
    switch (kind) {
      case 'code': { const c = el('code'); c.textContent = m[1]; parent.append(c); break; }
      case 'image': { const href = safeUrl(m[2]); if (href) link(href, `🖼 ${m[1] || 'image'}`, parent); else parent.append(m[0]); break; }
      case 'link': { const href = safeUrl(m[2]); if (href) link(href, { text: m[1] }, parent); else parent.append(m[1]); break; }
      case 'auto': { const href = safeUrl(m[1]); if (href) link(href, m[1].replace(/^mailto:/, ''), parent); else parent.append(m[0]); break; }
      default: { const e = el({ strong: 'strong', del: 'del', em: 'em' }[kind]); inline(inner, e); parent.append(e); }
    }
    text = text.slice(m.index + m[0].length);
  }
}
