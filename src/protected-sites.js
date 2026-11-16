// Sites whose terms forbid extensions and other automated means to read ("scrape") or act on their pages
// while you are signed in; some restrict accounts that do it. The extension neither reads these pages nor
// acts on them, and the agent does not open them. The built-in list cannot be changed in the settings;
// the user can add domains (a domain covers its subdomains).

/** name, domains ("amazon.*" = amazon under any country domain, such as amazon.de or amazon.co.uk). */
export const BUILT_IN = [
  { name: 'LinkedIn', domains: ['linkedin.com'] },
  { name: 'Facebook', domains: ['facebook.com', 'messenger.com'] },
  { name: 'Instagram', domains: ['instagram.com'] },
  { name: 'Threads', domains: ['threads.net', 'threads.com'] },
  { name: 'WhatsApp', domains: ['whatsapp.com'] },
  { name: 'X (Twitter)', domains: ['x.com', 'twitter.com'] },
  { name: 'TikTok', domains: ['tiktok.com'] },
  { name: 'Reddit', domains: ['reddit.com'] },
  { name: 'Pinterest', domains: ['pinterest.*'] },
  { name: 'Amazon', domains: ['amazon.*'] },
  { name: 'Indeed', domains: ['indeed.*'] },
  { name: 'Glassdoor', domains: ['glassdoor.*'] },
  { name: 'Upwork', domains: ['upwork.com'] }
];

let userDomains = [];

/** "https://www.Example.com/x" or "example.com/" → "example.com"; '' when it is not a domain. */
export function cleanDomain(text) {
  let s = String(text || '').trim().toLowerCase();
  if (!s) return '';
  try { if (/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = new URL(s).hostname; } catch { return ''; }
  s = s.replace(/[/?#:].*$/, '').replace(/^\*?\.|^www\./g, '').replace(/\.$/, '');
  return /^([a-z0-9-]+\.)+[a-z0-9-]{2,}$/.test(s) ? s : '';
}

/** The domains the user added (in the settings). */
export function setUserProtected(list) {
  userDomains = [...new Set((Array.isArray(list) ? list : []).map(cleanDomain).filter(Boolean))];
  return userDomains;
}

function matches(host, domain) {
  if (!domain.endsWith('.*')) return host === domain || host.endsWith(`.${domain}`);
  // name.* : the name followed by a country or generic domain of at most two short parts (co.uk, com.au, de).
  const labels = host.split('.');
  const i = labels.lastIndexOf(domain.slice(0, -2));
  const rest = labels.slice(i + 1);
  return i >= 0 && rest.length >= 1 && rest.length <= 2 && rest.every((l) => /^[a-z]{2,3}$/.test(l));
}

/** The protected site of a URL: { name, builtIn } or null. */
export function protectedSite(url) {
  let host;
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return null;
    host = u.hostname.toLowerCase().replace(/\.$/, '');
  } catch { return null; }
  for (const s of BUILT_IN) if (s.domains.some((d) => matches(host, d))) return { name: s.name, builtIn: true };
  const own = userDomains.find((d) => matches(host, d));
  return own ? { name: own, builtIn: false } : null;
}

export class ProtectedSiteError extends Error {
  constructor(site) {
    super(`${site.name} does not allow extensions to read or automate its pages${site.builtIn ? ' (its terms forbid it, and accounts can be restricted for it)' : ' (it is in your list of protected sites)'}, so Pagelore does not read or act on this page. You can copy the text you need into the chat yourself.`);
    this.name = 'ProtectedSiteError';
    this.site = site;
  }
}

/** Throws ProtectedSiteError when the URL is on a protected site. */
export function assertNotProtected(url) {
  const site = protectedSite(url);
  if (site) throw new ProtectedSiteError(site);
}
