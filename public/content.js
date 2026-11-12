// In-page agent. Injected on demand by the side panel into the extension's isolated world.
// It never runs model output as code: the panel can only call the fixed API at the bottom of this file.
(() => {
  'use strict';
  const VERSION = 7;
  if (globalThis.__localAI?.version === VERSION) return;

  // ---------- Stable element ids ----------
  let nextId = 1;
  const idByEl = new WeakMap();
  const refById = new Map();
  function idOf(el) {
    let id = idByEl.get(el);
    if (!id) {
      id = nextId++;
      idByEl.set(el, id);
      refById.set(id, new WeakRef(el));
    }
    return id;
  }
  function elOf(id) {
    const el = refById.get(Number(id))?.deref();
    return el && el.isConnected ? el : null;
  }

  // ---------- Text normalization (keep in sync with src/text.js) ----------
  // Generic Unicode folding: lower-case, accents/combining marks removed, invisible format characters
  // dropped, digits of any script mapped to ASCII. Each UTF-16 unit maps to '' or one character.
  const SPACE_RE = /\s/;
  const MARK_RE = /\p{M}/u;
  const FORMAT_RE = /\p{Cf}/u;
  const DIGIT_RE = /\p{Nd}/u;
  const MARKS_ONLY_RE = /^\p{M}+$/u;
  const digitCache = new Map();
  function digitValue(c) {
    let v = digitCache.get(c);
    if (v === undefined) {
      const cp = c.codePointAt(0);
      let zero = cp;
      while (zero > 0 && DIGIT_RE.test(String.fromCodePoint(zero - 1)) && cp - zero < 9) zero--;
      v = String(cp - zero);
      digitCache.set(c, v);
    }
    return v;
  }
  function normChar(c) {
    if (SPACE_RE.test(c)) return ' ';
    if (MARK_RE.test(c) || FORMAT_RE.test(c)) return '';
    if (c >= '0' && c <= '9') return c;
    if (DIGIT_RE.test(c)) return digitValue(c);
    const d = c.normalize('NFD');
    const base = d.length > 1 && MARKS_ONLY_RE.test(d.slice(1)) ? d[0] : c;
    const lower = base.toLowerCase();
    return lower.length === 1 ? lower : base;
  }
  function normalize(s) {
    const str = String(s || '');
    let out = '';
    for (let i = 0; i < str.length; i++) {
      const n = normChar(str[i]);
      if (n === ' ' && (out === '' || out.endsWith(' '))) continue;
      out += n;
    }
    return out.trim();
  }
  const clean = (s, max = 200) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);

  // ---------- Visibility & DOM walking ----------
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'IFRAME', 'OBJECT', 'HEAD', 'SELECT', 'OPTION', 'TEXTAREA']);
  const CHROME_SEL = 'nav,footer,aside,[role="navigation"],[role="banner"],[role="contentinfo"],[role="complementary"],body > header';
  const INLINE = new Set(['inline', 'inline-block', 'inline-flex', 'inline-grid', 'contents', 'ruby']);

  function isVisible(el, cache) {
    if (!el) return false;
    if (cache?.has(el)) return cache.get(el);
    let v;
    if (el.checkVisibility) v = el.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true });
    else v = el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    if (v && el.closest('[aria-hidden="true"]')) v = false;
    cache?.set(el, v);
    return v;
  }

  function textNodesUnder(roots, visCache = new Map(), { keepWhitespace = false } = {}) {
    const nodes = [];
    const seen = new Set();
    for (const root of roots) {
      if (!root) continue;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const p = node.parentElement;
          if (!p || SKIP_TAGS.has(p.tagName) || p.closest('script,style,noscript,template,svg')) return NodeFilter.FILTER_REJECT;
          if (!keepWhitespace && !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
          return isVisible(p, visCache) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
      });
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!seen.has(n)) { seen.add(n); nodes.push(n); }
      }
    }
    return nodes;
  }

  // Normalized searchable index over text nodes, with a map back to DOM positions.
  function buildIndex(nodes, { compact = false } = {}) {
    let text = '';
    const map = [];
    for (const node of nodes) {
      if (!compact && text && !text.endsWith(' ')) { text += ' '; map.push({ node, offset: 0 }); }
      const value = node.nodeValue;
      for (let i = 0; i < value.length; i++) {
        const n = normChar(value[i]);
        if (!n) continue;
        if (n === ' ' && (compact || text === '' || text.endsWith(' '))) continue;
        text += n;
        map.push({ node, offset: i });
      }
    }
    return { text, map };
  }
  function rangeFor(index, start, end) {
    const a = index.map[start], b = index.map[end - 1];
    if (!a || !b) return null;
    const r = document.createRange();
    r.setStart(a.node, a.offset);
    r.setEnd(b.node, Math.min(b.offset + 1, b.node.nodeValue.length));
    return r;
  }
  function findAllIn(index, needle, limit = 300) {
    const out = [];
    if (!needle) return out;
    let from = 0;
    while (out.length < limit) {
      const at = index.text.indexOf(needle, from);
      if (at < 0) break;
      out.push([at, at + needle.length]);
      from = at + Math.max(1, needle.length);
    }
    return out;
  }

  // ---------- Page extraction ----------
  function blockOf(el, displayCache) {
    let cur = el;
    while (cur && cur !== document.body) {
      let d = displayCache.get(cur);
      if (d === undefined) { d = getComputedStyle(cur).display; displayCache.set(cur, d); }
      if (!INLINE.has(d)) return cur;
      cur = cur.parentElement;
    }
    return document.body;
  }

  function structuredData() {
    const lines = [];
    const meta = (sel) => document.querySelector(sel)?.getAttribute('content')?.trim();
    const desc = meta('meta[name="description"]') || meta('meta[property="og:description"]');
    if (desc) lines.push(`Description: ${clean(desc, 400)}`);
    const site = meta('meta[property="og:site_name"]');
    if (site) lines.push(`Site: ${clean(site, 80)}`);
    const visit = (node, depth = 0) => {
      if (!node || typeof node !== 'object' || depth > 4 || lines.length > 30) return;
      if (Array.isArray(node)) { node.forEach((n) => visit(n, depth + 1)); return; }
      const type = [].concat(node['@type'] || []).join(',');
      if (/Product|Offer|Article|NewsArticle|BlogPosting|Event|Recipe|Book|Course|SoftwareApplication|LocalBusiness|JobPosting/i.test(type)) {
        const pick = ['name', 'title', 'hiringOrganization', 'employmentType', 'headline', 'description', 'brand', 'sku', 'price', 'lowPrice', 'highPrice', 'priceCurrency', 'availability', 'datePublished', 'author', 'startDate', 'location'];
        const parts = [];
        for (const k of pick) {
          let v = node[k];
          if (v == null) continue;
          if (typeof v === 'object') v = v.name || v['@id'] || (Array.isArray(v) ? v.map((x) => x?.name || x).join(', ') : '');
          if (v) parts.push(`${k}: ${clean(v, 200)}`);
        }
        if (node.aggregateRating?.ratingValue) parts.push(`rating: ${node.aggregateRating.ratingValue}/${node.aggregateRating.bestRating || 5} (${node.aggregateRating.reviewCount || node.aggregateRating.ratingCount || '?'} reviews)`);
        if (parts.length) lines.push(`${type}: ${parts.join('; ')}`);
      }
      for (const key of ['@graph', 'offers', 'mainEntity', 'itemListElement']) if (node[key]) visit(node[key], depth + 1);
    };
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try { visit(JSON.parse(s.textContent)); } catch { /* ignore malformed JSON-LD */ }
    }
    const price = document.querySelector('[itemprop="price"]');
    if (price) {
      const cur = document.querySelector('[itemprop="priceCurrency"]');
      lines.push(`Price (microdata): ${clean(price.getAttribute('content') || price.textContent, 40)} ${clean(cur?.getAttribute('content') || cur?.textContent || '', 10)}`.trim());
    }
    return lines.join('\n');
  }

  function extract({ maxChars = 300000 } = {}) {
    const displayCache = new Map();
    const visCache = new Map();
    const nodes = textNodesUnder([document.body], visCache, { keepWhitespace: true });
    const blocks = [];
    let total = 0;
    let current = null;
    for (const node of nodes) {
      const block = blockOf(node.parentElement, displayCache);
      if (!current || current.el !== block) {
        if (current) blocks.push(current);
        current = { el: block, parts: [] };
      }
      current.parts.push(node.nodeValue);
    }
    if (current) blocks.push(current);

    const out = [];
    for (const b of blocks) {
      const text = clean(b.parts.join(''), 4000);
      if (text.length < 2) continue;
      const tag = b.el.tagName.toLowerCase();
      const heading = /^h[1-6]$/.test(tag) ? Number(tag[1]) : (b.el.getAttribute('role') === 'heading' ? Number(b.el.getAttribute('aria-level') || 2) : 0);
      out.push({ id: idOf(b.el), tag, text, heading, chrome: !!b.el.closest(CHROME_SEL) });
      total += text.length;
      if (total > maxChars) break;
    }
    return {
      title: document.title,
      url: location.href,
      lang: document.documentElement.lang || '',
      meta: structuredData(),
      selection: clean(String(getSelection() || ''), 4000),
      blocks: out
    };
  }

  // ---------- Highlighting (CSS Custom Highlight API: no DOM mutation) ----------
  let hits = [];
  let hitIndex = 0;
  function setHits(ranges) {
    hits = ranges.filter(Boolean);
    if (!hits.length) { clearHighlights(); return { total: 0 }; }
    CSS.highlights.set('local-ai-hit', new Highlight(...hits));
    return focusHit(0);
  }
  function focusHit(i) {
    if (!hits.length) return { total: 0, index: -1 };
    hitIndex = ((i % hits.length) + hits.length) % hits.length;
    const r = hits[hitIndex];
    CSS.highlights.set('local-ai-focus', new Highlight(r));
    const el = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement;
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return { total: hits.length, index: hitIndex };
  }
  function moveHit(delta) { return focusHit(hitIndex + delta); }
  function clearHighlights() {
    CSS.highlights.delete('local-ai-hit');
    CSS.highlights.delete('local-ai-focus');
    hits = [];
    return true;
  }

  function findAll(query) {
    const needle = normalize(query);
    if (!needle) return { total: 0, snippets: [] };
    const nodes = textNodesUnder([document.body]);
    let index = buildIndex(nodes);
    let spans = findAllIn(index, needle);
    if (!spans.length) {
      // Spacing of compounds varies (post code / postcode, Datei Name / Dateiname): retry ignoring spaces.
      const compactNeedle = needle.replace(/ /g, '');
      if (compactNeedle.length >= 3) {
        index = buildIndex(nodes, { compact: true });
        spans = findAllIn(index, compactNeedle);
      }
    }
    const ranges = spans.map(([s, e]) => rangeFor(index, s, e));
    const res = setHits(ranges);
    // Snippets come from the original text of the surrounding block (not the normalized index).
    const snippets = ranges.slice(0, 8).filter(Boolean).map((r) => {
      const c = r.commonAncestorContainer;
      const el = (c.nodeType === 1 ? c : c.parentElement);
      const block = el.closest('p,li,td,th,dd,dt,h1,h2,h3,h4,h5,h6,blockquote,pre,div,section,article') || el;
      const full = clean(block.innerText, 3000);
      const hit = clean(r.toString(), 200);
      const at = Math.max(0, full.indexOf(hit));
      const a = Math.max(0, at - 60), b = Math.min(full.length, at + hit.length + 60);
      return (a > 0 ? '…' : '') + full.slice(a, b) + (b < full.length ? '…' : '');
    });
    return { ...res, snippets };
  }

  function highlightQuote(blockIds, quote) {
    const els = (blockIds || []).map(elOf).filter(Boolean);
    if (!els.length) return { total: 0, matched: false };
    const index = buildIndex(textNodesUnder(els));
    const words = normalize(quote).split(' ').filter(Boolean).slice(0, 40);
    // Small models paraphrase: try the full quote, then progressively shorter word windows.
    for (let len = words.length; len >= Math.min(3, words.length) && len > 0; len--) {
      for (let start = 0; start + len <= words.length; start++) {
        const needle = words.slice(start, start + len).join(' ');
        if (needle.length < 6 && len < words.length) continue;
        const at = index.text.indexOf(needle);
        if (at >= 0) return { ...setHits([rangeFor(index, at, at + needle.length)]), matched: true };
      }
    }
    return { ...highlightBlocks(blockIds), matched: false };
  }

  function highlightBlocks(blockIds) {
    const ranges = (blockIds || []).map(elOf).filter(Boolean).map((el) => {
      const r = document.createRange();
      r.selectNodeContents(el);
      return r;
    });
    return setHits(ranges);
  }

  // ---------- Forms ----------
  const EXCLUDED_TYPES = new Set(['password', 'file', 'hidden', 'submit', 'button', 'reset', 'image']);
  const SENSITIVE_AUTOCOMPLETE = /cc-number|cc-csc|current-password|new-password|one-time-code/;

  function textOfIds(ids) {
    return (ids || '').split(/\s+/).map((i) => document.getElementById(i)?.innerText || '').join(' ');
  }
  function labelText(el) {
    const parts = [];
    if (el.getAttribute('aria-labelledby')) parts.push(textOfIds(el.getAttribute('aria-labelledby')));
    if (el.labels?.length) parts.push([...el.labels].map((l) => l.innerText).join(' '));
    if (el.getAttribute('aria-label')) parts.push(el.getAttribute('aria-label'));
    if (!clean(parts.join(' ')) && el.placeholder) parts.push(el.placeholder);
    if (!clean(parts.join(' ')) && el.title) parts.push(el.title);
    if (!clean(parts.join(' '))) {
      // Nearby text: previous sibling or the parent's own text.
      const prev = el.previousElementSibling;
      if (prev && !prev.matches('input,select,textarea,button')) parts.push(prev.innerText || '');
      else if (el.parentElement) parts.push([...el.parentElement.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join(' '));
    }
    // aria-labelledby and <label> often repeat the same text ("Email * Email"): keep each piece once.
    const seen = [];
    for (const part of parts.map((x) => clean(x || '', 120)).filter(Boolean)) {
      const n = normalize(part).replace(/[^\p{L}\p{N} ]/gu, '').trim();
      const i = seen.findIndex((x) => x.n.includes(n) || n.includes(x.n));
      if (i < 0) seen.push({ n, part });
      else if (n.length > seen[i].n.length) seen[i] = { n, part };
    }
    return clean(seen.map((x) => x.part).join(' '), 120);
  }
  function groupText(el) {
    const fs = el.closest('fieldset');
    const legend = fs?.querySelector('legend')?.innerText;
    const grp = el.closest('[role="radiogroup"],[role="group"]');
    const grpLabel = grp && (grp.getAttribute('aria-label') || textOfIds(grp.getAttribute('aria-labelledby')));
    return clean(legend || grpLabel || '', 100);
  }
  function fieldKind(el) {
    if (el instanceof HTMLSelectElement) return 'select';
    if (el instanceof HTMLTextAreaElement) return 'textarea';
    const t = (el.type || 'text').toLowerCase();
    if (t === 'checkbox' || t === 'radio') return t;
    return 'text';
  }

  /**
   * Where the form is: the open dialog that holds fields (the innermost one), or else the whole page.
   * With a dialog open, fields and buttons of the page behind it (a language picker in the footer,
   * a search box) are left out: changing them could change the page itself.
   */
  function formScope() {
    const vis = new Map();
    const dialogs = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"],dialog[open],[aria-modal="true"]')]
      .filter((d) => isVisible(d, vis) && [...d.querySelectorAll('input,textarea,select')]
        .some((el) => !EXCLUDED_TYPES.has((el.type || '').toLowerCase()) && !el.disabled && isVisible(el, vis)));
    return dialogs.at(-1) || document;
  }
  /** The form or dialog of a field (its id, or 0): only fields that share one with a proposal are cleared. */
  const boxOf = (el) => { const c = el.closest('[role="dialog"],[role="alertdialog"],dialog,form'); return c ? idOf(c) : 0; };
  /** How to find a field again when the page re-rendered it (new element, same label, name and position). */
  const locatorKey = (kind, label, name) => `${kind}|${normalize(label)}|${name}`;
  function findByLocator(loc) {
    if (!loc) return null;
    const vis = new Map();
    const same = [...formScope().querySelectorAll('input,textarea,select')].filter((el) => {
      const type = (el.type || el.tagName).toLowerCase();
      if (EXCLUDED_TYPES.has(type) || type === 'radio' || el.disabled || el.readOnly) return false;
      if (!isVisible(el, vis) && type !== 'checkbox') return false;
      return locatorKey(fieldKind(el), labelText(el), el.name || '') === loc.key;
    });
    return same[loc.nth] || (same.length === 1 ? same[0] : null);
  }

  let radioGroups = new Map();
  function listFields() {
    radioGroups = new Map();
    const fields = [];
    const visCache = new Map();
    const seenRadio = new Set();
    const nth = new Map();
    for (const el of formScope().querySelectorAll('input,textarea,select')) {
      const type = (el.type || el.tagName).toLowerCase();
      if (EXCLUDED_TYPES.has(type) || el.disabled || el.readOnly) continue;
      if (SENSITIVE_AUTOCOMPLETE.test(el.autocomplete || '')) continue;
      if (!isVisible(el, visCache) && !(type === 'radio' || type === 'checkbox')) continue;
      const kind = fieldKind(el);
      const base = {
        kind, type, name: el.name || '', autocomplete: el.getAttribute('autocomplete') || '',
        required: !!el.required, group: groupText(el), box: boxOf(el)
      };
      if (kind === 'text' && isSearchInput(el, type)) base.search = true;
      if (kind === 'radio') {
        const key = `${el.form ? idOf(el.form) : 0}:${el.name || idOf(el)}`;
        if (seenRadio.has(key)) continue;
        seenRadio.add(key);
        const radios = [...document.querySelectorAll(`input[type="radio"]`)].filter((r) => r.name === el.name && r.form === el.form && !r.disabled && (isVisible(r, visCache) || r.labels?.[0] && isVisible(r.labels[0], visCache)));
        if (!radios.length) continue;
        const id = idOf(radios[0]);
        radioGroups.set(id, radios);
        const options = radios.map((r) => labelText(r) || r.value);
        fields.push({ ...base, id, label: base.group || el.name, options, value: options[radios.findIndex((r) => r.checked)] || '' });
        continue;
      }
      if (kind === 'checkbox' && !isVisible(el, visCache) && !(el.labels?.[0] && isVisible(el.labels[0], visCache))) continue;
      const field = { ...base, id: idOf(el), label: labelText(el), placeholder: clean(el.placeholder, 60) };
      const key = locatorKey(kind, field.label, base.name);
      field.locator = { key, nth: nth.get(key) || 0 };
      nth.set(key, field.locator.nth + 1);
      if (kind === 'select') {
        field.options = [...el.options].filter((o) => !o.disabled).map((o) => clean(o.text, 60) || o.value).slice(0, 60);
        field.value = clean(el.selectedOptions[0]?.text || '', 60);
      } else if (kind === 'checkbox') {
        field.value = el.checked ? 'true' : 'false';
      } else {
        field.value = clean(el.value, 300);
      }
      fields.push(field);
      if (fields.length >= 120) break;
    }
    return fields;
  }

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function matchOption(candidates, wanted) {
    const w = normalize(wanted);
    if (!w) return -1;
    const norm = candidates.map(normalize);
    let i = norm.indexOf(w);
    if (i < 0) i = norm.findIndex((c) => c && (c.includes(w) || w.includes(c)));
    return i;
  }
  const truthy = (v) => /^(true|yes|y|1|on|checked|enabled)$/i.test(String(v).trim());

  function flash(el) {
    const prev = el.style.outline;
    const prevOffset = el.style.outlineOffset;
    el.style.outline = '3px solid #ff9f1c';
    el.style.outlineOffset = '2px';
    setTimeout(() => { el.style.outline = prev; el.style.outlineOffset = prevOffset; }, 1400);
  }

  function fillOne(id, value, locator) {
    const group = radioGroups.get(Number(id));
    if (group) {
      const live = group.filter((r) => r.isConnected);
      const idx = matchOption(live.map((r) => labelText(r) || r.value), value);
      if (idx < 0) return { ok: false, message: `no option matches “${value}”` };
      if (!live[idx].checked) live[idx].click();
      flash(live[idx].labels?.[0] || live[idx]);
      return { ok: true };
    }
    const el = elOf(id) || findByLocator(locator);
    if (!el) return { ok: false, message: 'the field is not on the page now: scan the form again' };
    const type = (el.type || '').toLowerCase();
    if (EXCLUDED_TYPES.has(type) || el.disabled || el.readOnly) return { ok: false, message: 'field is not fillable' };
    if (el instanceof HTMLSelectElement) {
      const opts = [...el.options];
      if (String(value) === '') { // clear: the empty option, or the first one (usually "Select…")
        const empty = opts.findIndex((o) => o.value === '');
        setNativeValue(el, opts[empty >= 0 ? empty : 0].value);
        flash(el);
        return { ok: true };
      }
      let idx = matchOption(opts.map((o) => o.text), value);
      if (idx < 0) idx = matchOption(opts.map((o) => o.value), value);
      if (idx < 0) return { ok: false, message: `no option matches “${value}”` };
      setNativeValue(el, opts[idx].value);
    } else if (type === 'checkbox') {
      if (el.checked !== truthy(value)) el.click();
    } else {
      el.focus({ preventScroll: true });
      setNativeValue(el, String(value));
      if (String(value) && !el.value) return { ok: false, message: `value “${value}” is not valid for a ${type} field` };
      el.dispatchEvent(new Event('blur', { bubbles: false }));
    }
    flash(el);
    return { ok: true };
  }

  function fillFields(updates) {
    return (updates || []).map((u) => {
      try { return { id: u.id, ...fillOne(u.id, u.value, u.locator) }; }
      catch (e) { return { id: u.id, ok: false, message: e.message }; }
    });
  }

  // ---------- Interactive elements & actions ----------
  const INTERACTIVE = [
    'a[href]', 'button', 'input', 'select', 'textarea', 'summary', 'label[for]',
    '[role="button"]', '[role="link"]', '[role="tab"]', '[role="menuitem"]', '[role="menuitemcheckbox"]',
    '[role="menuitemradio"]', '[role="option"]', '[role="checkbox"]', '[role="radio"]', '[role="switch"]',
    '[role="combobox"]', '[role="textbox"]', '[role="searchbox"]', '[contenteditable=""]', '[contenteditable="true"]', '[onclick]'
  ].join(',');

  function accessibleName(el) {
    const aria = el.getAttribute('aria-label') || textOfIds(el.getAttribute('aria-labelledby'));
    if (clean(aria)) return clean(aria, 90);
    if (el.matches('input,select,textarea')) {
      const t = (el.type || '').toLowerCase();
      if (['submit', 'button', 'reset'].includes(t)) return clean(el.value || t, 90);
      return labelText(el);
    }
    const txt = clean(el.innerText, 90);
    if (txt) return txt;
    return clean(el.title || el.querySelector('img[alt]')?.alt || el.getAttribute('alt') || '', 90);
  }

  /** A field that only runs a search (Enter in it searches; it does not submit an order or a message). */
  function isSearchInput(el, type) {
    if (type === 'search' || el.getAttribute('role') === 'searchbox') return true;
    if (!['', 'text', 'textarea'].includes(type)) return false;
    if (el.closest('[role="search"]')) return true;
    if (/^(q|query|search|search_query|searchterm|keywords?|k|s|text|w|st|field-keywords)$/i.test(el.name || '')) {
      const form = el.form;
      return !form || /search|suche|recherche|buscar|zoek|find|query|\/s(\?|$)/i.test(`${form.getAttribute('action') || ''} ${form.getAttribute('role') || ''} ${form.id} ${form.className}`) || form.querySelectorAll('input:not([type=hidden]),textarea,select').length <= 2;
    }
    return /search|suche|recherche|buscar|cerca|zoek|szukaj|pesquis/i.test(`${el.placeholder || ''} ${el.getAttribute('aria-label') || ''} ${el.id} ${el.className}`);
  }

  // ---------- Messages the page shows: toasts, alerts, field errors ----------
  // A click or an entry often gets its answer as text, not as a new element: "This skill is already on
  // your profile", "Saved", an error under a field. Such text often appears outside the form or dialog
  // (a toast in a corner, a live region at the end of the page). The watcher records text that appears
  // after an action in alerts, live regions, toasts and error messages anywhere on the page, and new
  // text in the dialog or form the action was in, so the agent hears what the page said.
  const NOTICE_SEL = '[role="alert"],[role="status"],[role="alertdialog"],[aria-live="polite"],[aria-live="assertive"],output,' +
    '[class*="toast" i],[class*="snackbar" i],[class*="notification" i],[class*="notice" i],[class*="alert" i],' +
    '[class*="error" i],[class*="invalid" i],[class*="feedback" i],[class*="flash" i]';
  const BOX_SEL = '[role="dialog"],[role="alertdialog"],dialog,form';
  let msgClock = 0, msgObserver = null, actionBox = null;
  const msgSeen = new Map(); // element → { at, text }
  function noteChange(node, attrOnly = false) {
    const el = node.nodeType === 1 ? node : node.parentElement;
    if (!el || el.closest('[role="listbox"],[role="option"],[role="menu"],script,style')) return;
    let target = el.closest(NOTICE_SEL);
    // New text in the form or dialog of the action (not a class change there: focus styles are not news).
    if (!target && !attrOnly && actionBox?.isConnected && actionBox.contains(el)) target = el.closest('p,span,div,li,label') || el;
    if (!target) return;
    const full = String(target.innerText || target.textContent || '').trim();
    if (!full || full.length > 400) return; // a message is short; a large box is not one
    msgSeen.set(target, { at: msgClock, text: clean(full, 300) });
  }
  function watchMessages() {
    if (msgObserver || !document.body) return;
    msgObserver = new MutationObserver((list) => {
      for (const m of list) {
        if (m.type === 'childList') for (const n of m.addedNodes) {
          noteChange(n);
          if (n.nodeType === 1) for (const x of n.querySelectorAll?.(NOTICE_SEL) || []) noteChange(x);
        } else noteChange(m.target, m.type === 'attributes');
      }
    });
    msgObserver.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'hidden', 'style', 'aria-hidden', 'aria-invalid'] });
  }
  /** The error message of a field marked invalid (aria-errormessage / aria-describedby), or ''. */
  function fieldError(el) {
    if (el.getAttribute('aria-invalid') !== 'true') return '';
    const t = textOfIds(el.getAttribute('aria-errormessage')) || textOfIds(el.getAttribute('aria-describedby'));
    return clean(t || 'marked as invalid', 200);
  }
  /** Text that appeared since the mark (only what is still or was briefly visible), newest last. */
  function pageMessages({ since = 0 } = {}) {
    const vis = new Map(), out = [];
    for (const [el, m] of msgSeen) {
      if (m.at < since) continue;
      const now = el.isConnected && isVisible(el, vis) ? clean(el.innerText || el.textContent, 300) : '';
      const text = now || m.text; // a toast may be gone already: what it said still counts
      if (text && !out.some((o) => o.includes(text) || text.includes(o))) out.push(text);
    }
    for (const el of document.querySelectorAll('[aria-invalid="true"]')) {
      const e = fieldError(el);
      if (e && isVisible(el, vis)) { const t = `${labelText(el) || accessibleName(el)}: ${e}`; if (!out.some((o) => o.includes(e))) out.push(t); }
    }
    return out.slice(-6);
  }
  /** Notices visible now (alerts, live regions, toasts with text). */
  function visibleNotices() {
    const vis = new Map(), out = [];
    for (const el of document.querySelectorAll('[role="alert"],[role="status"],[role="alertdialog"],[aria-live="assertive"],[class*="toast" i],[class*="snackbar" i]')) {
      if (!isVisible(el, vis)) continue;
      const t = clean(el.innerText, 300);
      if (t && !out.some((o) => o.includes(t) || t.includes(o))) out.push(t);
    }
    return out.slice(0, 6);
  }

  function snapshot({ limit = 400 } = {}) {
    const visCache = new Map();
    const out = [];
    const vh = innerHeight, vw = innerWidth;
    for (const el of document.querySelectorAll(INTERACTIVE)) {
      const type = (el.type || '').toLowerCase();
      if (el.matches('input') && ['hidden', 'password', 'file'].includes(type)) continue;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
      if (!isVisible(el, visCache)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) continue;
      if (SENSITIVE_AUTOCOMPLETE.test(el.autocomplete || '')) continue;
      const tag = el.tagName.toLowerCase();
      const item = {
        id: idOf(el), tag, role: el.getAttribute('role') || '', type,
        text: accessibleName(el),
        inViewport: rect.bottom > 0 && rect.right > 0 && rect.top < vh && rect.left < vw
      };
      if (el.matches('input,textarea')) {
        if (type === 'checkbox' || type === 'radio') item.checked = el.checked;
        else {
          // A long value is shortened in the middle, with its length, so the agent can see the field is filled.
          const v = clean(el.value, 100000);
          item.value = v.length > 90 ? `${v.slice(0, 60)} … ${v.slice(-25)}` : v;
          if (v.length > 90) item.valueLength = el.value.length;
        }
        if (isSearchInput(el, type)) item.search = true;
        const err = fieldError(el);
        if (err) item.error = err;
      }
      if (el instanceof HTMLSelectElement) {
        item.options = [...el.options].map((o) => clean(o.text, 40)).slice(0, 20);
        item.value = clean(el.selectedOptions[0]?.text || '', 40);
      }
      if (tag === 'a') {
        try { const u = new URL(el.href); item.href = (u.origin === location.origin ? '' : u.host) + u.pathname.slice(0, 60); } catch { /* ignore */ }
      }
      if (!item.text && !item.href && tag !== 'input' && tag !== 'textarea' && tag !== 'select') continue;
      out.push(item);
      if (out.length >= limit) break;
    }
    return {
      url: location.href,
      title: document.title,
      scroll: { y: Math.round(scrollY), max: Math.round(document.documentElement.scrollHeight - innerHeight) },
      elements: out,
      notices: visibleNotices()
    };
  }

  function mouseSequence(el) {
    const opts = { bubbles: true, cancelable: true, composed: true, view: window };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.click();
  }

  let mark = 0;
  function perform(step) {
    mark = 0;
    const res = performAction(step);
    return mark ? { ...res, mark } : res;
  }
  function performAction({ action, id, value }) {
    if (action === 'scroll_down' || action === 'scroll_up') {
      window.scrollBy({ top: (action === 'scroll_down' ? 1 : -1) * innerHeight * 0.8, behavior: 'instant' });
      return { ok: true, message: `scrolled ${action === 'scroll_down' ? 'down' : 'up'}` };
    }
    const el = elOf(id);
    if (!el) return { ok: false, message: `element ${id} no longer exists` };
    const type = (el.type || '').toLowerCase();
    if (el.matches('input') && ['password', 'file', 'hidden'].includes(type)) return { ok: false, message: 'this field type is not allowed' };
    // Watch what the page says after this action (read with pageMessages, since this mark).
    watchMessages();
    actionBox = el.closest(BOX_SEL);
    mark = ++msgClock;
    for (const [k, m] of msgSeen) if (m.at < msgClock - 3) msgSeen.delete(k); // keep the last actions only
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    flash(el);
    switch (action) {
      case 'click':
        mouseSequence(el);
        return { ok: true, message: `clicked “${accessibleName(el)}”` };
      case 'type': {
        el.focus();
        if (el.isContentEditable) {
          document.execCommand('selectAll', false);
          document.execCommand('insertText', false, String(value ?? ''));
        } else if (el.matches('input,textarea')) {
          setNativeValue(el, String(value ?? ''));
        } else {
          return { ok: false, message: 'element is not a text field' };
        }
        const want = String(value ?? '');
        const now = el.isContentEditable ? el.innerText : el.value;
        const shown = want.length > 120 ? `${want.slice(0, 100)}…` : want;
        if (want.length <= 120) return { ok: true, message: `typed “${shown}” into “${accessibleName(el)}”` };
        return { ok: true, message: `typed into “${accessibleName(el)}”: ${want.length} characters, ` +
          `${now.length >= want.length ? 'the field holds all of them' : `but the field kept only ${now.length} (it may have a length limit)`} (“${shown}”)` };
      }
      case 'select': {
        if (el instanceof HTMLSelectElement) {
          const r = fillOne(id, value);
          return r.ok ? { ok: true, message: `selected “${value}”` } : r;
        }
        mouseSequence(el);
        return { ok: true, message: `clicked option “${accessibleName(el)}”` };
      }
      case 'check':
      case 'uncheck': {
        const want = action === 'check';
        const current = el.matches('input') ? el.checked : el.getAttribute('aria-checked') === 'true';
        if (current !== want) mouseSequence(el);
        return { ok: true, message: `${action}ed “${accessibleName(el)}”` };
      }
      case 'press_enter': {
        el.focus();
        const init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
        const notHandled = el.dispatchEvent(new KeyboardEvent('keydown', init));
        el.dispatchEvent(new KeyboardEvent('keypress', init));
        el.dispatchEvent(new KeyboardEvent('keyup', init));
        if (notHandled && el.form) el.form.requestSubmit();
        return { ok: true, message: `pressed Enter in “${accessibleName(el)}”` };
      }
      default:
        return { ok: false, message: `unknown action ${action}` };
    }
  }

  // ---------- Site search and result lists (for the Research agent) ----------
  // Pages that stop automated use: CAPTCHAs, bot checks and rate limits. Only strong signals count:
  // many normal pages carry an invisible reCAPTCHA badge, so a CAPTCHA script alone is not enough.
  const BLOCK_PHRASES = /unusual traffic|are you a robot|not a robot|verify (that )?you are (a )?human|verifying you are human|confirm you are (a )?human|human verification|robot check|bot check|enter the characters you see|type the characters you see|solve (this|the) (captcha|puzzle)|complete the (captcha|security check)|checking (if the site connection is secure|your browser)|too many requests|access to this page has been denied|request blocked|pardon our interruption|sind sie ein roboter|kein roboter|ungewöhnlichen datenverkehr|êtes-vous un robot|pas un robot|trafic inhabituel|no soy un robot|eres un robot|tráfico inusual|non sono un robot|traffico insolito/i;
  const BLOCK_TITLES = /^(just a moment|attention required|access denied|robot check|are you a robot|security check|captcha|one more step|too many requests)\b/i;
  function blocked() {
    const nav = performance.getEntriesByType('navigation')[0];
    const status = nav?.responseStatus || 0;
    const text = clean(document.body?.innerText || '', 3000);
    const title = document.title.trim();
    const visibleChallenge = [...document.querySelectorAll('iframe[src*="recaptcha/api2/anchor"], iframe[src*="recaptcha/enterprise/anchor"], iframe[src*="hcaptcha.com"], iframe[src*="challenges.cloudflare.com"], #challenge-form, #cf-challenge-running, .cf-turnstile, #px-captcha, #captcha-container, form[action*="captcha" i], img[src*="captcha" i]')]
      .some((el) => { const r = el.getBoundingClientRect(); return r.width > 40 && r.height > 20; });
    let reason = '';
    if (status === 429) reason = 'the site says there were too many requests (HTTP 429)';
    else if (BLOCK_TITLES.test(title)) reason = `the page title is “${title.slice(0, 60)}”`;
    else if (BLOCK_PHRASES.test(text) && (text.length < 2500 || visibleChallenge)) reason = `the page says “${(text.match(BLOCK_PHRASES) || [''])[0]}”`;
    // A CAPTCHA inside a login, sign-up or contact form is part of that form, not a block.
    else if (visibleChallenge && text.length < 1500 && !document.querySelector('input[type=password], input[type=email], textarea')) reason = 'the page shows a CAPTCHA';
    return { blocked: !!reason, reason, status };
  }

  const SEARCH_WORDS = /search|suche|recherche|rechercher|buscar|busca|cerca|zoeken|szukaj|sök|find/i;
  function searchInput() {
    const cands = [...document.querySelectorAll('input[type="search"], [role="search"] input, form[role="search"] input, input[name], input[aria-label], input[placeholder]')]
      .filter((el) => {
        const type = (el.type || 'text').toLowerCase();
        if (!['search', 'text', ''].includes(type) || el.disabled || el.readOnly) return false;
        return isVisible(el);
      });
    const score = (el) => {
      let s = 0;
      if ((el.type || '').toLowerCase() === 'search') s += 4;
      if (el.closest('[role="search"], form[role="search"]')) s += 4;
      if (/^(q|k|s|query|search|search_query|keywords?|field-keywords|term|text|_nkw|w)$/i.test(el.name || '')) s += 3;
      if (SEARCH_WORDS.test(`${el.getAttribute('aria-label') || ''} ${el.placeholder || ''} ${el.id || ''} ${el.name || ''} ${el.form?.action || ''}`)) s += 3;
      if (el.form) s += 1;
      return s;
    };
    const best = cands.map((el) => ({ el, s: score(el) })).filter((c) => c.s >= 3).sort((a, b) => b.s - a.s)[0];
    return best?.el || null;
  }

  /** Type a query into the site's own search box and submit it. The page then navigates. */
  function submitSearch({ query }) {
    const el = searchInput();
    if (!el) return { ok: false, message: 'no search box found on this page' };
    el.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, String(query || ''));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    const init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    const notHandled = el.dispatchEvent(new KeyboardEvent('keydown', init));
    el.dispatchEvent(new KeyboardEvent('keypress', init));
    el.dispatchEvent(new KeyboardEvent('keyup', init));
    if (notHandled && el.form) {
      if (el.form.requestSubmit) el.form.requestSubmit(); else el.form.submit();
    }
    return { ok: true, message: 'submitted' };
  }

  const NEXT_WORDS = /^(next|next page|weiter|nächste|suivant|siguiente|successivo|successiva|volgende|następna|›|»|→)$/i;
  /**
   * Items of a result list: each link with the text of the smallest "card" around it (title, price,
   * rating…). Generic: works on shop results, search engines, listings and article indexes.
   */
  function listItems({ limit = 30, maxText = 260 } = {}) {
    const vis = new Map();
    const seenCards = new Set();
    const seenUrls = new Set();
    const items = [];
    for (const a of document.querySelectorAll('a[href]')) {
      if (items.length >= limit) break;
      let url;
      try { url = new URL(a.href, location.href); } catch { continue; }
      if (!/^https?:$/.test(url.protocol)) continue;
      if (url.origin === location.origin && url.pathname === location.pathname) continue;
      if (a.closest(CHROME_SEL) || !isVisible(a, vis)) continue;
      // Grow from the link to the largest ancestor that still looks like one item.
      let card = a;
      for (let p = a.parentElement; p && p !== document.body; p = p.parentElement) {
        const len = (p.innerText || '').length;
        if (len > 900 || p.querySelectorAll('a[href]').length > 12) break;
        card = p;
      }
      const text = clean(card.innerText || a.innerText || a.title || a.getAttribute('aria-label'), maxText);
      if (text.length < 25) continue;
      const key = url.origin + url.pathname;
      if (seenCards.has(card) || seenUrls.has(key)) continue;
      seenCards.add(card); seenUrls.add(key);
      url.hash = '';
      items.push({ text, url: url.href.slice(0, 400) });
    }
    let next = document.querySelector('a[rel~="next"][href], link[rel~="next"][href]')?.href || '';
    if (!next) {
      for (const el of document.querySelectorAll('a[href], [role="link"][href]')) {
        const t = clean(el.innerText || el.getAttribute('aria-label') || '', 40);
        if (NEXT_WORDS.test(t) || /next/i.test(el.getAttribute('aria-label') || '')) { next = el.href; break; }
      }
    }
    return { url: location.href, title: document.title, items, next: next || '' };
  }

  // ---------- "Add …" buttons of a form (Add skill, Add language…) ----------
  const ADD_RE = /^\s*\+?\s*(add|hinzufügen|ajouter|añadir|agregar|aggiungi|toevoegen)\b|\b(hinzufügen|toevoegen)\s*$/i;
  // Not list items: files and media, shopping, or links.
  const ADD_SKIP = /media|file|photo|image|picture|video|attachment|upload|document|\blink\b|cart|basket|bag|wish|datei|foto|bild|anhang|warenkorb|fichier|panier|archivo|carrito|immagine|carrello/i;
  const isTextInput = (el) => el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && ['', 'text', 'search', 'email', 'url', 'tel'].includes((el.type || '').toLowerCase())) || el?.getAttribute?.('role') === 'combobox';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(fn, ms) {
    const end = Date.now() + ms;
    for (;;) {
      const v = fn(Date.now() + ms - end);
      if (v || Date.now() > end) return v || null;
      await sleep(100);
    }
  }
  /** The containers (form, dialog) that hold the page's fillable fields. */
  function fieldContainers() {
    const scope = formScope();
    if (scope !== document) return [scope];
    const vis = new Map();
    const set = new Set();
    for (const el of document.querySelectorAll('input,textarea,select')) {
      const type = (el.type || '').toLowerCase();
      if (EXCLUDED_TYPES.has(type) || el.disabled || !isVisible(el, vis)) continue;
      const c = el.closest('[role="dialog"],dialog,form');
      if (c) set.add(c);
    }
    return [...set];
  }
  function addButtons() {
    const vis = new Map();
    const out = [];
    for (const c of fieldContainers()) {
      for (const el of c.querySelectorAll('button,[role="button"]')) {
        if (el.disabled || el.getAttribute('aria-disabled') === 'true' || !isVisible(el, vis)) continue;
        const label = accessibleName(el);
        if (!label || label.length > 40 || !ADD_RE.test(label) || ADD_SKIP.test(label) || (el.type || '').toLowerCase() === 'submit') continue;
        if (!out.some((b) => b.el === el || b.label === label)) out.push({ el, label });
      }
    }
    return out;
  }
  /** Buttons that add one item to a form each time (for example "Add skill"): [{ id, label }]. */
  function listAdders() {
    return addButtons().slice(0, 10).map((b) => ({ id: idOf(b.el), label: b.label, group: groupText(b.el) }));
  }
  const visibleTextInputs = () => { const vis = new Map(); return [...document.querySelectorAll('input,textarea,[role="combobox"]')].filter((el) => isTextInput(el) && !el.disabled && !el.readOnly && isVisible(el, vis)); };
  /** The visible suggestion that matches the value: exact first; after a while, one that contains it. */
  function matchingOption(input, value, waited) {
    const vis = new Map();
    const scope = document.getElementById(input.getAttribute('aria-controls') || input.getAttribute('aria-owns') || '') || document;
    const opts = [...scope.querySelectorAll('[role="option"]')].filter((o) => isVisible(o, vis));
    const w = normalize(value);
    const texts = opts.map((o) => normalize(o.innerText || o.getAttribute('aria-label') || ''));
    let i = texts.findIndex((t) => t === w);
    if (i < 0 && waited > 1200) i = texts.findIndex((t) => t.startsWith(w));
    if (i < 0 && waited > 2000) i = texts.findIndex((t) => t.includes(w));
    return i >= 0 ? opts[i] : null;
  }
  /**
   * For each value: click the "Add …" button, type the value into the field that appears and pick the
   * matching suggestion (when the field offers a list). Never presses Enter, which could submit the form.
   */
  async function addItems({ id, label, values }) {
    const results = [];
    for (const value of values || []) {
      const button = elOf(id) || addButtons().find((b) => b.label === label)?.el;
      if (!button) { results.push({ value, ok: false, message: `the “${label}” button is not on the page now` }); continue; }
      const before = new Set(visibleTextInputs());
      button.scrollIntoView({ block: 'center', behavior: 'instant' });
      mouseSequence(button);
      const input = await waitFor(() => {
        const a = document.activeElement;
        if (isTextInput(a) && !before.has(a)) return a;
        return visibleTextInputs().find((x) => !before.has(x));
      }, 2500) || (isTextInput(document.activeElement) && !document.activeElement.value ? document.activeElement : null);
      if (!input) { results.push({ value, ok: false, message: `no field appeared after clicking “${label}”` }); continue; }
      input.focus();
      if (input.isContentEditable) document.execCommand('insertText', false, value);
      else setNativeValue(input, value);
      input.dispatchEvent(new KeyboardEvent('keyup', { key: value.slice(-1), bubbles: true }));
      const option = await waitFor((waited) => matchingOption(input, value, waited), 3000);
      if (option) {
        mouseSequence(option);
        flash(input);
        results.push({ value, ok: true });
      } else if (input.getAttribute('aria-autocomplete') || input.getAttribute('role') === 'combobox' || input.getAttribute('aria-controls')) {
        results.push({ value, ok: false, message: 'typed, but no matching suggestion appeared: choose it on the page' });
        break; // the open field would take the next value too
      } else {
        flash(input);
        results.push({ value, ok: true });
      }
      await sleep(400);
    }
    return results;
  }

  globalThis.__localAI = {
    version: VERSION,
    extract, findAll, moveHit, clearHighlights, highlightQuote, highlightBlocks,
    listFields, fillFields, listAdders, addItems, snapshot, perform, pageMessages, submitSearch, listItems, blocked
  };
})();
