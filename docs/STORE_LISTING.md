# Chrome Web Store submission — Pagelore

Copy-ready text for the Chrome Web Store Developer Dashboard. Replace the items in `<angle brackets>`.

Upload file: `release/pagelore-<version>.zip` (created by `npm run package`).

---

## Store listing tab

**Name** (from the manifest): Pagelore – AI side panel with your own model

**Summary** (max 132 characters; the store takes it from `description` in the manifest, so keep both the same):

> AI in the side panel with your own model (Ollama, LM Studio or an API): ask, summarize, search, fill forms and run tasks.

**Category:** Productivity → Tools (or Workflow & Planning)

**Language:** English

**Detailed description:**

```
Pagelore puts an AI assistant in Chrome's side panel that works with the page you are viewing. It uses the model you choose: one running on your own computer with Ollama or LM Studio, so your pages and documents never leave your device, or any online model with an OpenAI-compatible API. There is no developer server, no account and no tracking.

WHAT IT DOES
• Chat – ask questions about the page and get answers with sources you can highlight on the page, or describe a task ("find a 14-inch laptop under 900 euros and compare the best three"): the assistant plans, searches the site, reads pages, clicks and types. Risky steps such as submitting, paying or deleting always ask for confirmation.
• Summarize – short, medium or detailed summaries of long articles and pages.
• Smart search – find text instantly (ignoring case, accents and spacing) with every match highlighted; when nothing matches literally, the AI finds the passage that answers your query.
• Fill forms – fill web forms from information you saved or from your own attached files. You review every value before it is applied, and forms are never submitted.
• Attach files – add PDF, Word (.docx) or text files and ask questions about them or use them to fill forms.
• One session per tab, and a history of your chats on your device.

YOUR MODEL, YOUR CHOICE
The extension contains no AI model. In Settings → Models, click "Ollama" or "LM Studio" to use a model on your computer, or enter the URL and key of an online provider (OpenAI, OpenRouter, Requesty and others). Page content is read only when you start a feature and is sent only to the model you chose.

REQUIREMENTS
• Chrome 116 or newer.
• Ollama or LM Studio with a model (8B or larger recommended for multi-step tasks), or an account with an OpenAI-compatible API.

AI models can make mistakes. Check important answers against the source, which is highlighted on the page.
```

**Graphics** (all in `docs/store-assets/`):
- Store icon 128×128: `public/icons/icon-128.png`
- Screenshots (1280×800), upload in this order:
  1. `screenshot-1-agent.png`: the agent compares three laptops
  2. `screenshot-2-chat.png`: an answer with its source highlighted on the page
  3. `screenshot-3-form.png`: a contact form filled from saved info
  4. `screenshot-4-summarize.png`: a summary of a long article
  5. `screenshot-5-models.png`: adding an Ollama model in Settings
- Small promo tile 440×280: `promo-small-440x280.png`
- Marquee promo tile 1400×560: `promo-marquee-1400x560.png`

**Official URL / Homepage:** https://github.com/majid-rafei/pagelore
**Support URL:** https://github.com/majid-rafei/pagelore/issues

---

## Privacy practices tab

**Single purpose description:**

> Provide an AI assistant in the side panel that helps the user understand and interact with the web page they are viewing (summarize, answer questions, search, fill forms and perform page actions), using an AI model the user chooses (on their own computer or an OpenAI-compatible API).

**Permission justifications:**

| Permission | Justification |
|---|---|
| `activeTab` | Gives temporary access to the tab the user is viewing when they open the assistant, so the extension can read that page's text (to summarize, answer or search it) and act on it (fill forms, click) only after a user request. |
| `scripting` | Injects the extension's own bundled content script into the active tab on demand. The script extracts page text, highlights search results and performs the form filling or clicks the user asked for. No remote code is injected. |
| `sidePanel` | The whole user interface is a side panel shown next to the page. |
| `storage` | Saves the user's settings (model, language, options), optional "My saved info" text for form filling, the models the user added (URL, key, model name) and the user's history locally in `chrome.storage.local`. Nothing is synced. |
| `unlimitedStorage` | The history of chats (the last 100 entries, which can include the text of files the user attached) is kept in `chrome.storage.local` and can exceed its default 10 MB limit. No data leaves the device through this permission. |
| Optional host permission `<all_urls>` | Requested in two cases. (1) When the user adds a model in Settings, for that server's origin only, so requests reach a server that does not accept browser (CORS) requests. (2) When the user clicks "Allow access" in the panel, for all sites. Without it, `activeTab` access ends when the user switches tabs, and the user must click the toolbar icon again. Granting it lets the side panel keep working on whichever tab is active. The extension still reads a page only when the user starts a feature. |

**Are you using remote code?** No.

> All JavaScript (including pdf.js) is bundled in the package. The extension downloads no code; the only network requests are chat requests to the model server the user entered, whose replies are text and are never evaluated as code.

**Data usage** — tick these two:

| Data type | Tick? | Why |
|---|---|---|
| Personally identifiable information | **Yes** | "My saved info" (name, email, address…) is sent to the model the user chose when they fill a form. |
| Website content | **Yes** | The text of the page is sent to the model the user chose when they ask, summarize, search or run a task. |
| Health information | No | |
| Financial and payment information | No | Payment-card fields are never read. |
| Authentication information | No | Password fields are never read; API keys are sent only to their own server. |
| Personal communications | No | |
| Location | No | |
| Web history | No | |
| User activity | No | |

Why tick them although the developer receives nothing: the store counts data sent off the device as collected, and with an online provider the page text and saved info leave the device (to the provider the user configured, at the user's request). Declaring them is the safe answer and matches the privacy policy; leaving them unticked is a common reason for rejection.

**Certifications** (tick all three):
- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL:** https://github.com/majid-rafei/pagelore/blob/main/docs/PRIVACY.md

---

## Distribution tab

- Visibility: Public (or Unlisted for a soft launch)
- Regions: All regions
- Pricing: Free

---

## Test instructions for the reviewer

Reviewers rarely install Ollama. To make the review easy, add an API key to the instructions: create a separate key at a provider (for example OpenAI or OpenRouter) with a small spend limit (a few dollars), fill in the first bullet below, and revoke it after the item is approved. The field is visible only to the review team.

```
No account or login is required.

The extension contains no model; it needs an OpenAI-compatible model server. Either:
  • (easiest) use this test key: open the panel's Settings (⚙) → Models → Add a model, enter
      API URL: <e.g. https://api.openai.com/v1>
      API key: <test key with a spend limit>
      Model:   <e.g. gpt-4o-mini>
    then click "Test" and "Save"; or
  • install Ollama (https://ollama.com), run "ollama pull qwen3:8b", and in Settings (⚙) → Models → Add a model click "Ollama", choose qwen3:8b, "Test", "Save".

1. Open any article (e.g. https://en.wikipedia.org/wiki/Chrome_Web_Store) and click the extension's toolbar icon to open the side panel.
2. Chat tab → type "What is this page about?" → Send. Click a source to see it highlighted on the page.
3. Summarize tab → "Summarize".
4. Search tab → type a word from the page → every match is highlighted (this works without a model).
5. Form filling: open a page with a form (e.g. https://httpbin.org/forms/post). In the Form tab, enter these lines in "My saved info":
      Customer name: Anna Schmidt
      Telephone: +49 89 1234567
      Email: anna.schmidt@example.com
   click "Scan form & prepare values", review the values and click "Apply selected".
6. Tasks: in the Chat tab, type "click <button text>" on a page with that button. Risky steps ask for confirmation.

If the side panel says it needs permission for the site, click "Allow access", or click the toolbar icon again on that tab.
```
