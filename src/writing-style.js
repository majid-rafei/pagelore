// Writing style for prose the model writes (form texts, answers, summaries). Chosen once in Settings and
// shared by every tab. Not used for structured tasks (field matching), where it would only add noise.

export const WRITING_STYLES = {
  natural: {
    label: 'Natural (like a person wrote it)',
    guide: 'Write like a person, not like an AI assistant: plain everyday words, short sentences of varied length, ' +
      'concrete details instead of praise. Avoid clichés and buzzwords such as "I am writing to express", "passionate", ' +
      '"delve", "leverage", "robust", "seamless", "furthermore" or "in today\'s fast-paced world". ' +
      'Do not use em dashes. Do not end with a sentence that sums up what you already said.'
  },
  formal: {
    label: 'Formal',
    guide: 'Use a clear, polite and formal tone with complete sentences. Avoid slang and exaggeration.'
  },
  custom: { label: 'Custom…', guide: '' },
  none: { label: 'Model default (no style instruction)', guide: '' }
};
export const DEFAULT_STYLE = 'natural';
export const CUSTOM_STYLE_MAX = 500;

let style = DEFAULT_STYLE;
let custom = '';

export function setWritingStyle(name, customText = '') {
  style = WRITING_STYLES[name] ? name : DEFAULT_STYLE;
  custom = String(customText || '').trim().slice(0, CUSTOM_STYLE_MAX);
}

/** The style instruction to append to a system prompt (starts with a space), or '' for none. */
export function styleGuide() {
  const guide = style === 'custom' ? (custom && `Writing style the user asked for: ${custom}`) : WRITING_STYLES[style].guide;
  return guide ? ` ${guide}` : '';
}
