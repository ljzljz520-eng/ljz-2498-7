export function parseHref(anchorTag) {
  const match = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(anchorTag);
  return match ? (match[1] ?? match[2] ?? match[3]) : null;
}

export function isUnsubscribeAnchor(anchorTag, href) {
  const tag = anchorTag.toLowerCase();
  if (/rel\s*=\s*["'][^"']*\bunsubscribe\b/.test(tag)) return true;
  if (/\bdata-(?:no-)?(?:shortlink|tracking|rewrite)\s*=\s*["'](?:true|preserve|1)["']/.test(tag)) return true;
  if (/\bdata-unsubscribe\s*=\s*["'](?:true|1)["']/.test(tag)) return true;
  try {
    const url = new URL(href);
    if (url.protocol === 'mailto:') return /unsubscribe/i.test(urlToAddress(url));
    return /\/unsubscribe(?:\/|$)/i.test(url.pathname) || url.searchParams.has('unsubscribe_token');
  } catch {
    return false;
  }
}

function urlToAddress(url) {
  return `${url.pathname}${url.search}`.replace(/^\//, '');
}

export function appendTracking(href, params) {
  const url = new URL(href);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return href;
  for (const [key, value] of Object.entries(params)) {
    if (!/^[a-z][a-z0-9_.-]*$/i.test(key)) {
      throw Object.assign(new Error(`Unsafe tracking parameter ${key}`), { status: 400 });
    }
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export function inspectAnchors(html) {
  const anchors = [];
  const anchorPattern = /<a\b[^>]*>/gis;
  for (const match of html.matchAll(anchorPattern)) {
    const tag = match[0];
    anchors.push({ tag, href: parseHref(tag), protected: false });
  }
  return anchors;
}

export function validatePublishedLink(href, { unsubscribe = false } = {}) {
  if (href == null) return { ok: false, code: 'MISSING_HREF', message: 'anchor without href' };
  const trimmed = href.trim();
  if (!trimmed) return { ok: false, code: 'EMPTY_HREF', message: 'empty href' };
  if (Array.from(trimmed).some((char) => char.charCodeAt(0) < 32)) {
    return { ok: false, code: 'CONTROL_CHAR', message: 'control character in URL' };
  }
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, code: 'INVALID_URL', message: `invalid absolute URL: ${maskUrl(trimmed)}` };
  }
  if (['javascript:', 'data:', 'vbscript:', 'file:'].includes(url.protocol)) {
    return { ok: false, code: 'FORBIDDEN_PROTOCOL', message: `${url.protocol} links are forbidden` };
  }
  if (unsubscribe) {
    if (!['https:', 'mailto:'].includes(url.protocol)) {
      return { ok: false, code: 'UNSUBSCRIBE_PROTOCOL', message: 'unsubscribe link must be https or mailto' };
    }
    if (url.protocol === 'https:' && !url.searchParams.get('unsubscribe_token')) {
      return { ok: false, code: 'UNSUBSCRIBE_TOKEN_MISSING', message: 'unsubscribe link lacks token' };
    }
  } else if (!['http:', 'https:'].includes(url.protocol)) {
    return { ok: false, code: 'UNEXPECTED_PROTOCOL', message: `${url.protocol} is only allowed for unsubscribe` };
  }
  return { ok: true };
}

function maskUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol + '//' + parsed.host;
  } catch {
    return '[unparseable]';
  }
}
