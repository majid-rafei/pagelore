# Privacy Policy — Local AI Browser Assistant

_Last updated: 11 November 2026_

Local AI Browser Assistant ("the extension") is an AI assistant in Chrome's side panel. It contains no AI model of its own: you choose the model it uses, either one that runs on your own computer (for example with Ollama or LM Studio) or one offered by an online provider through an OpenAI-compatible API. The extension has no server, no account and no analytics. This policy explains what the extension reads, where that data goes, and what it stores.

## Summary

- The extension does **not** send your data to the developer.
- The text each request needs goes only to the model server **you** entered. With a model on your computer (Ollama, LM Studio) it does not leave your device; with an online provider it goes to that provider.
- There is no tracking, advertising, analytics or sale of data.

## What the extension reads

| Data | When | Purpose |
|---|---|---|
| Text, links and form fields of the current web page | Only when you start a feature in the side panel (Chat, Summarize, Search, Form) | To create the answer, summary, search result, form values or page action you asked for |
| Text you type (questions, instructions, tasks) | When you submit it | Same as above |
| Files you attach (PDF, Word, text) | When you choose or drop a file | To answer questions or fill forms from your own documents |
| "My saved info" text you enter in the Form tab | When you type it | To fill forms with your details |

The extension never reads password, file, hidden or payment-card fields, and it does not read pages in the background. It reads a page only after you start a feature on that tab.

## Where the data goes

**Models you add.** In Settings you add a model by entering a server's URL, an API key (if the server needs one) and a model name. A model is chosen per tab. Each action sends the text it needs to that server: the relevant page text, your question or instruction, the parts of "My saved info" and of attached files used for the request, and the earlier conversation in a follow-up.

- With a server on your own computer (an address such as `localhost`), this text stays on your device.
- With an online provider (for example OpenAI, OpenRouter or Requesty), the text goes to that provider, and what the provider does with it is governed by its own privacy policy, not this one. The panel shows a notice while a tab uses such a model.

Your API key is sent only to the server you entered it for. The extension may ask Chrome for access to that server's site so requests work; you can decline or revoke it in `chrome://extensions`.

Page processing and file reading (PDF, Word) are done inside the extension. No other network requests are made.

## What is stored, and where

| Stored item | Location | How to delete it |
|---|---|---|
| Settings (model choice, answer language, options) and the "My saved info" text you entered | `chrome.storage.local` on your device (not synced) | Clear the fields, or remove the extension |
| Models you added (name, URL, API key, model name, prices) | `chrome.storage.local` on your device (not synced) | Remove the model in Settings, or remove the extension |
| History (the last 100 chats, summaries, searches and form fills, with the text of files attached in a chat) | `chrome.storage.local` on your device (not synced) | Delete entries in History, or remove the extension |
| Current output, attachments and the optional model log of each tab | Memory of the side panel only | Discarded when the side panel is closed |

## Permissions

- **activeTab / scripting**: read or act on the current tab only after you start a feature in the side panel.
- **sidePanel**: show the assistant next to the page.
- **storage**: remember your settings, saved info, models and history on your device.
- **unlimitedStorage**: keep the history on your device even when it grows beyond Chrome's default storage limit (chats can include the text of attached files).
- **Access to the site of a model server you add** (optional): requested when you test or save the model, so the panel can reach that server.
- **Optional access to all sites**: requested only if you click **Allow access**, so features keep working when you switch tabs without clicking the toolbar icon again. You can revoke it at any time in `chrome://extensions`.

## Children

The extension is not directed at children and does not knowingly collect any data from anyone.

## Changes

If this policy changes, the updated version will be published at this address with a new date.

## Contact

Questions about this policy: open an issue at <https://github.com/majid-rafei/local-ai-browser-assistant/issues>.
