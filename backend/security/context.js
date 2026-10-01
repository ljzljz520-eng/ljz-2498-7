export function escapeHtml(input = '') {
  return String(input)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function escapeAttribute(input) {
  return escapeHtml(input).replaceAll('\r', '').replaceAll('\n', '');
}

export function escapeJsString(input) {
  return JSON.stringify(String(input))
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(RegExp(String.fromCharCode(8232), 'g'), '\\u2028')
    .replace(RegExp(String.fromCharCode(8233), 'g'), '\\u2029');
}

export function escapeUrlPath(input) {
  return encodeURIComponent(String(input)).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function normalizeContext(raw = {}) {
  const result = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!/^[a-z][a-z0-9_]*$/i.test(key)) {
      throw Object.assign(new Error(`Unsafe context key: ${key}`), { status: 400 });
    }
    const stringValue = String(value ?? '');
    if (Array.from(stringValue).some((char) => char.charCodeAt(0) < 32 && char !== '\t')) {
      throw Object.assign(new Error(`Control characters are not allowed in context value: ${key}`), { status: 400 });
    }
    result[key] = typeof value === 'number' || typeof value === 'boolean' ? value : stringValue;
  }
  return result;
}

export function substituteLiteral(input, context) {
  return String(input ?? '').replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/gi, (_, key) => {
    if (!(key in context)) throw Object.assign(new Error(`Missing context value: ${key}`), { status: 400 });
    return String(context[key]);
  });
}
