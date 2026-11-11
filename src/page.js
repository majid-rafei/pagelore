// Bridge between the side panel and the in-page agent (public/content.js).

export class PageAccessError extends Error {
  constructor(message) { super(message); this.name = 'PageAccessError'; }
}

const HIGHLIGHT_CSS = `
::highlight(local-ai-hit){background-color:rgba(255,214,0,.55);color:inherit}
::highlight(local-ai-focus){background-color:#ff9f1c;color:#000}`;

function assertReadable(tab) {
  const url = tab.url || tab.pendingUrl;
  // Without host access to a tab (no activeTab grant, no "Allow access"), Chrome hides its URL.
  // That is a permission problem, not an unreadable page: show the access banner instead.
  if (!url) {
    throw new PageAccessError('The extension has no access to this tab yet. Click the extension icon while this tab is open, or click “Allow access” to use the assistant on any tab.');
  }
  if (!/^(https?|file):/.test(url) || /^https:\/\/chrome(webstore)?\.google\.com\/webstore/.test(url)) {
    throw new Error('This page cannot be read (browser pages such as chrome:// or the New Tab page are protected). Open a normal web page (http/https) first.');
  }
  return tab;
}

export async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new Error('No active tab found.');
  return assertReadable(tab);
}

function wrapError(e) {
  const msg = e?.message || String(e);
  if (/Cannot access|permission|must request permission|Missing host permission/i.test(msg)) {
    return new PageAccessError('The extension does not have access to this page. Click “Allow access” and try again.');
  }
  return e;
}

/** A handle bound to one tab, so a multi-step task keeps working on the same tab. */
export class PageHandle {
  constructor(tabId) { this.tabId = tabId; }

  static async active() {
    const tab = await getActiveTab();
    return new PageHandle(tab.id);
  }

  /** Handle for a specific tab (checks that the tab still exists and is a readable page). */
  static async forTab(tabId) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error('This tab was closed.');
    return new PageHandle(assertReadable(tab).id);
  }

  async ensureInjected() {
    try {
      const [probe] = await chrome.scripting.executeScript({
        target: { tabId: this.tabId },
        func: () => globalThis.__localAI?.version ?? 0
      });
      if (probe?.result === 5) return; // keep in sync with VERSION in content.js
      await chrome.scripting.executeScript({ target: { tabId: this.tabId }, files: ['content.js'] });
      await chrome.scripting.insertCSS({ target: { tabId: this.tabId }, css: HIGHLIGHT_CSS });
    } catch (e) {
      throw wrapError(e);
    }
  }

  /** Call a method of the in-page API (see the bottom of public/content.js). */
  async call(method, ...args) {
    await this.ensureInjected();
    let res;
    try {
      [res] = await chrome.scripting.executeScript({
        target: { tabId: this.tabId },
        args: [method, args],
        func: async (m, a) => {
          try { return { ok: true, value: await globalThis.__localAI[m](...a) }; }
          catch (e) { return { ok: false, error: String(e?.message || e) }; }
        }
      });
    } catch (e) {
      throw wrapError(e);
    }
    if (!res?.result) throw new Error('No response from the page.');
    if (!res.result.ok) throw new Error(res.result.error);
    return res.result.value;
  }

  /** Wait for navigation/rendering to settle after an action. */
  async waitForSettle({ timeout = 15000 } = {}) {
    await new Promise((r) => setTimeout(r, 400));
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const tab = await chrome.tabs.get(this.tabId).catch(() => null);
      if (!tab) throw new Error('The tab was closed.');
      if (tab.status === 'complete') break;
      await new Promise((r) => setTimeout(r, 250));
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Must be called synchronously from a click handler (user gesture). */
export function requestAllSitesAccess() {
  return chrome.permissions.request({ origins: ['<all_urls>'] });
}
