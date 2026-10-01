import { escapeAttribute, escapeHtml, escapeUrlPath, normalizeContext, substituteLiteral } from '../security/context.js';
import { appendTracking, inspectAnchors, isUnsubscribeAnchor, parseHref, validatePublishedLink } from './links.js';

function substituteUrl(input, context) {
  return String(input ?? '').replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/gi, (_, key) => {
    if (!(key in context)) throw Object.assign(new Error(`Missing context value: ${key}`), { status: 400 });
    return escapeUrlPath(context[key]);
  });
}

const NAMED_COLORS = {
  black: [0, 0, 0], white: [255, 255, 255], red: [255, 0, 0], lime: [0, 255, 0],
  blue: [0, 0, 255], yellow: [255, 255, 0], cyan: [0, 255, 255], magenta: [255, 0, 255],
  gray: [128, 128, 128], grey: [128, 128, 128], silver: [192, 192, 192],
  darkgray: [169, 169, 169], lightgray: [211, 211, 211], green: [0, 128, 0],
};

export function validateTemplate(input = {}) {
  const errors = [];
  const warnings = [];
  const subject = String(input.subject ?? '');
  const previewText = String(input.previewText ?? input.preview_text ?? '');
  const bodyHtml = String(input.bodyHtml ?? input.body_html ?? '');
  const trackingParams = input.trackingParams ?? input.tracking_params ?? {};

  if (!subject.trim()) errors.push({ code: 'SUBJECT_REQUIRED', message: 'subject is required' });
  if (!previewText.trim()) errors.push({ code: 'PREVIEW_REQUIRED', message: 'preview text is required' });
  if (!bodyHtml.trim()) errors.push({ code: 'BODY_REQUIRED', message: 'body is required' });
  if (/\r|\n/.test(subject) || /\r|\n/.test(previewText)) {
    errors.push({ code: 'HEADER_INJECTION', message: 'subject and preview must not contain line breaks' });
  }
  if (/<\s*script\b/i.test(bodyHtml) || /<\s*iframe\b/i.test(bodyHtml) || /<\s*object\b/i.test(bodyHtml)) {
    errors.push({ code: 'FORBIDDEN_TAG', message: 'script, iframe and object tags are forbidden' });
  }
  if (/\s\s*on[a-z]+\s*=/i.test(bodyHtml)) {
    errors.push({ code: 'EVENT_HANDLER', message: 'inline event handlers are forbidden' });
  }
  if (/\s(?:href|src)\s*=\s*(?:'|")?\s*(?:javascript|data|vbscript):/i.test(bodyHtml)) {
    errors.push({ code: 'FORBIDDEN_PROTOCOL', message: 'dangerous URL protocol' });
  }
  for (const key of Object.keys(trackingParams)) {
    if (!/^[a-z][a-z0-9_.-]*$/i.test(key)) {
      errors.push({ code: 'UNSAFE_TRACKING_KEY', message: `tracking parameter ${key} is unsafe` });
    }
  }

  const anchors = inspectAnchors(bodyHtml);
  let unsubscribeAnchors = 0;
  const links = [];
  for (const { tag, href } of anchors) {
    const unsubscribe = isUnsubscribeAnchor(tag, href ?? '');
    if (unsubscribe) unsubscribeAnchors += 1;
    const hasPlaceholder = typeof href === 'string' && /\{\{\s*[a-z0-9_]+\s*\}\}/i.test(href);
    if (href != null && !hasPlaceholder) {
      const result = validatePublishedLink(href, { unsubscribe });
      if (!result.ok) errors.push({ code: result.code, message: result.message });
    }
    links.push({ href: href ?? null, unsubscribe, protected: unsubscribe, rewrite: !unsubscribe });
  }
  if (bodyHtml && unsubscribeAnchors === 0) {
    errors.push({ code: 'UNSUBSCRIBE_REQUIRED', message: 'body must contain rel="unsubscribe" or data-unsubscribe entry' });
  }

  const dark = analyzeDarkReadability(bodyHtml);
  errors.push(...dark.errors);
  warnings.push(...dark.warnings);
  const clientCapabilities = clientCapabilityMatrix(bodyHtml);

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    links,
    clientCapabilities,
    darkMode: dark.report,
  };
}

export function renderPublished(template, rawContext = {}) {
  const validation = validateTemplate(template);
  if (!validation.ok) {
    throw Object.assign(new Error('template validation failed'), { code: 'TEMPLATE_INVALID', details: validation.errors });
  }
  const context = normalizeContext(rawContext);
  const subject = substituteLiteral(template.subject, context);
  const previewText = substituteLiteral(template.previewText ?? template.preview_text, context);
  const trackingParams = template.trackingParams ?? template.tracking_params ?? {};
  const bodyHtml = String(template.bodyHtml ?? template.body_html ?? '');

  const linkMap = [];
  let unsubscribeCount = 0;
  const preparedBody = bodyHtml.replace(/<a\b[^>]*>/gis, (tag) => {
    const href = parseHref(tag);
    if (href == null) return tag;
    const renderedHref = substituteUrl(href, context);
    const unsubscribe = isUnsubscribeAnchor(tag, renderedHref);
    const linkCheck = validatePublishedLink(renderedHref, { unsubscribe });
    if (!linkCheck.ok) {
      throw Object.assign(new Error(linkCheck.message), { code: linkCheck.code });
    }
    let finalHref = renderedHref;
    if (unsubscribe) {
      unsubscribeCount += 1;
    } else {
      finalHref = appendTracking(renderedHref, trackingParams);
    }
    linkMap.push({ original: renderedHref, final: finalHref, unsubscribe, preserved: unsubscribe && renderedHref === finalHref });
    const safeHref = escapeAttribute(finalHref);
    const pattern = /(\shref\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s>]+)/i;
    return tag.replace(pattern, `$1"${safeHref}"`);
  });

  if (unsubscribeCount === 0) {
    throw Object.assign(new Error('rendered email has no unsubscribe entry'), { code: 'UNSUBSCRIBE_REQUIRED' });
  }
  if (linkMap.some((l) => l.unsubscribe && !l.preserved)) {
    throw Object.assign(new Error('unsubscribe address was rewritten'), { code: 'UNSUBSCRIBE_REWRITE_DETECTED' });
  }

  const escapedBody = preparedBody.replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/gi, (_, key) => {
    if (!(key in context)) throw Object.assign(new Error(`Missing context value: ${key}`), { status: 400 });
    return escapeHtml(context[key]);
  });
  if (/\{\{|\}\}/.test(escapedBody)) {
    throw Object.assign(new Error('unresolved personalization placeholder'), { code: 'UNRESOLVED_PLACEHOLDER' });
  }

  const previewNode = `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#333;background:#fff;">${escapeHtml(previewText)}</div>`;
  const html = injectPreview(escapedBody, previewNode);
  const text = htmlToText(html);
  return {
    subject,
    previewText,
    html,
    text,
    links: linkMap,
    validation,
  };
}

function injectPreview(html, previewNode) {
  if (/<body[^>]*>/i.test(html)) return html.replace(/<body[^>]*>/i, (match) => `${match}${previewNode}`);
  return `${previewNode}${html}`;
}

function analyzeDarkReadability(html) {
  const errors = [];
  const warnings = [];
  const styles = [...html.matchAll(/style\s*=\s*"([^"]*)"/gi)].map((m) => m[1]);
  for (const style of styles) {
    const color = parseCssColor(styleProperty(style, 'color'));
    const background = parseCssColor(styleProperty(style, 'background-color') ?? styleProperty(style, 'background'));
    if (color && !background && luminance(color) < 0.18) {
      warnings.push({ code: 'DARK_TEXT_NO_BACKGROUND', message: 'dark foreground without an explicit background may be unreadable in forced dark mode' });
    }
    if (color && background && contrast(color, background) < 4.5) {
      errors.push({ code: 'LOW_CONTRAST', message: 'text contrast is below WCAG AA 4.5:1' });
    }
  }
  if (styles.length && !/prefers-color-scheme\s*:\s*dark/i.test(html)) {
    warnings.push({ code: 'NO_DARK_MEDIA_QUERY', message: 'Gmail and several Outlook builds ignore or partially support dark media queries' });
  }
  return {
    errors,
    warnings,
    report: {
      checkedElements: styles.length,
      safe: !errors.some((e) => e.code === 'LOW_CONTRAST'),
    },
  };
}

function styleProperty(style, name) {
  const match = new RegExp(`(?:^|;)\\s*${name.replace('-', '\\s*-\\s*')}\\s*:\\s*([^;]+)`, 'i').exec(style);
  return match?.[1]?.trim();
}

function parseCssColor(value) {
  if (!value) return null;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (hex?.[1].length === 3) {
    const chars = hex[1];
    return [0, 1, 2].map((i) => parseInt(chars[i] + chars[i], 16));
  }
  if (hex?.[1].length === 6) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16));
  const rgb = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(value);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  return NAMED_COLORS[value.trim().toLowerCase()] ?? null;
}

function luminance([r, g, b]) {
  const values = [r, g, b].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2];
}

function contrast(a, b) {
  const x = luminance(a) + 0.05;
  const y = luminance(b) + 0.05;
  return Math.max(x, y) / Math.min(x, y);
}

function clientCapabilityMatrix(html) {
  return [
    { client: 'gmail-web', mediaQueries: false, cssVariables: false, forcedDark: 'partial', blocked: /<style/i.test(html) ? [] : [] },
    { client: 'apple-mail', mediaQueries: true, cssVariables: true, forcedDark: 'supported' },
    { client: 'outlook-desktop', mediaQueries: 'partial', cssVariables: false, forcedDark: 'unsupported' },
  ];
}

function htmlToText(html) {
  return html
    .replace(/<a\b[^>]*href\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => `${stripTags(text).trim()} <${href}>`)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripTags(html) {
  return html.replace(/<[^>]*>/g, '');
}
