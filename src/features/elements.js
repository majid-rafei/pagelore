// Page elements as the agent sees them, and the checks before it acts on one.
import { normalize } from '../text.js';

// Matched against accent-folded, lower-cased text (English plus common German, French, Spanish and Italian verbs).
const RISKY = /\b(submit|pay|buy|order|purchase|checkout|delete|remove|confirm|send|transfer|subscribe|unsubscribe|sign ?out|log ?out|publish|post|absenden|senden|bezahlen|kaufen|bestellen|loschen|entfernen|bestatigen|abmelden|abonnieren|envoyer|payer|acheter|commander|supprimer|confirmer|valider|deconnexion|enviar|pagar|comprar|pedir|eliminar|borrar|confirmar|invia|paga|acquista|ordina|elimina|conferma)\b/;

// Set by the page script (content.js) for fields that only run a search.
const isSearchField = (el) => !!el.search;

export function isRisky(step, el) {
  if (!el) return false;
  // Enter in a search field only runs a search; elsewhere it may submit a form.
  if (step.action === 'press_enter') return !isSearchField(el);
  if (step.action !== 'click') return false;
  return el.type === 'submit' || RISKY.test(normalize(`${el.text} ${el.href || ''}`));
}

export function describeElement(el) {
  if (!el) return '';
  let kind = el.role || el.tag;
  if (el.tag === 'input') kind = `input[${el.type || 'text'}]`;
  let s = `[${el.id}] ${kind} "${el.text}"`;
  if (el.value) s += ` value="${el.value}"${el.valueLength ? ` (${el.valueLength} characters; the middle is not shown)` : ''}`;
  if (el.checked !== undefined) s += el.checked ? ' (checked)' : ' (unchecked)';
  if (el.options) s += ` options: ${el.options.slice(0, 12).join(' | ')}`;
  if (el.href) s += ` → ${el.href}`;
  if (!el.inViewport) s += ' (off-screen)';
  return s;
}
const isTextField = (el) => (el.tag === 'input' && !['checkbox', 'radio', 'submit', 'button', 'reset', 'image', 'range', 'color'].includes(el.type))
  || el.tag === 'textarea' || ['textbox', 'searchbox', 'combobox'].includes(el.role);

/** Reject action/element combinations that cannot work, with feedback the model can act on. */
export function actionMismatch(action, el) {
  if (!el) return null;
  if ((action === 'type' || action === 'press_enter') && !isTextField(el)) return `${action} only works on text inputs; use "click" for buttons and links`;
  if (action === 'select' && el.tag !== 'select' && el.role !== 'option') return 'select only works on <select> elements; use "click"';
  if ((action === 'check' || action === 'uncheck') && !(el.type === 'checkbox' || el.type === 'radio' || ['checkbox', 'radio', 'switch', 'menuitemcheckbox'].includes(el.role))) return `${action} only works on checkboxes`;
  return null;
}

