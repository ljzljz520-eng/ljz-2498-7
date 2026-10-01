// 纯函数模板引擎：上下文转义、链接校验、短链改写（退订地址受保护）
import crypto from 'node:crypto';

// ---------- 转义 ----------
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
export function escapeAttr(value) { return escapeHtml(value); }
export function escapeUrl(value) {
  // 用于 href/查询参数：encodeURI + 额外的引号与空白控制
  return encodeURI(String(value ?? '')).replace(/['"`\s]/g, (c) =>
    '%' + c.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase());
}

function applyFilter(raw, filter) {
  switch (filter) {
    case 'h': case 'html': return escapeHtml(raw);
    case 'attr': return escapeAttr(raw);
    case 'u': case 'url': return escapeUrl(raw);
    case 'raw': return String(raw ?? '');
    default: return escapeHtml(raw); // 默认 HTML 转义
  }
}

// {{ var }} 默认转义；{{ var|u }} URL 转义；{{{ raw }}} 不转义（仅用于系统可信变量）
const TRUSTED_RAW = new Set(['unsubscribe_url', 'view_url', 'preferences_url']);

export function renderString(tpl, vars = {}) {
  if (tpl == null) return '';
  const src = String(tpl);
  let out = '';
  // 单次扫描：先识别三括号 raw（仅可信系统变量），其余按二括号转义
  const tokenRe = /\{\{\{\s*([\w.]+)\s*\}\}\}|\{\{\s*([\w.]+)(?:\s*\|\s*(\w+))?\s*\}\}/g;
  let last = 0; let m;
  while ((m = tokenRe.exec(src))) {
    out += src.slice(last, m.index);
    last = tokenRe.lastIndex;
    if (m[1] !== undefined) {
      // 非可信变量拒绝 raw 输出，原样保留占位符
      out += TRUSTED_RAW.has(m[1]) ? String(vars[m[1]] ?? '') : m[0];
    } else {
      out += applyFilter(vars[m[2]] ?? '', m[3] || 'h');
    }
  }
  out += src.slice(last);
  return out;
}

// ---------- 颜色 / 可读性 ----------
function parseColor(input) {
  if (!input) return null;
  let v = input.trim().toLowerCase();
  const NAMED = { black:[0,0,0], white:[255,255,255], red:[255,0,0], green:[0,128,0],
    blue:[0,0,255], yellow:[255,255,0], gray:[128,128,128], grey:[128,128,128],
    orange:[255,165,0], purple:[128,0,128] };
  if (NAMED[v]) return NAMED[v];
  let m = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (m) {
    let h = m[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  m = v.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const parts = m[1].split(',').map((x) => parseFloat(x));
    return [parts[0], parts[1], parts[2]];
  }
  return null;
}
function relLum([r, g, b]) {
  const a = [r, g, b].map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
}
export function contrastRatio(fg, bg) {
  const l1 = relLum(fg), l2 = relLum(bg);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

function extractColorDeclarations(html) {
  // 找到所有内联 style 声明对（color / background-color），按元素粗略配对
  const pairs = [];
  const tagRe = /<(\w+)([^>]*)\sstyle=["']([^"']*)["']([^>]*)>/gi;
  let m;
  while ((m = tagRe.exec(html))) {
    const style = m[3];
    const color = /(?:^|;)\s*color\s*:\s*([^;]+)/i.exec(style);
    const bg = /background(?:-color)?\s*:\s*([^;]+)/i.exec(style);
    pairs.push({ tag: m[1], fg: color ? parseColor(color[1]) : null, bg: bg ? parseColor(bg[1]) : null });
  }
  return pairs;
}

// 提取所有 @media (prefers-color-scheme: dark) 规则块的内部文本（花括号配对）
function extractDarkBlocks(html) {
  const blocks = [];
  const re = /@media\s*\([^)]*prefers-color-scheme\s*:\s*dark[^)]*\)\s*\{/gi;
  let m;
  while ((m = re.exec(html))) {
    let depth = 1, i = re.lastIndex;
    while (i < html.length && depth > 0) {
      if (html[i] === '{') depth++;
      else if (html[i] === '}') depth--;
      i++;
    }
    blocks.push(html.slice(re.lastIndex, i - 1));
  }
  return blocks;
}

// ---------- 链接发现 ----------
const UNSUB_KEYWORDS = ['/unsubscribe', 'unsubscribe?', 'optout', 'opt-out'];
export function isUnsubscribeHref(href) {
  const h = String(href || '').toLowerCase();
  return h === '{{unsubscribe_url}}' || h.includes('{{{unsubscribe_url}}}') ||
    UNSUB_KEYWORDS.some((k) => h.includes(k));
}
export function collectLinks(html) {
  const links = [];
  const re = /<a\b[^>]*?\bhref\s*=\s*(["'])([\s\S]*?)\1([^>]*)>/gi;
  let m;
  while ((m = re.exec(html))) {
    const before = m[0].slice(0, m.index - m.index);
    const fullTag = m[0];
    links.push({
      href: m[2],
      protected: /data-no-rewrite\b/i.test(fullTag) || isUnsubscribeHref(m[2]),
      index: m.index,
    });
  }
  return links;
}

export function validateUrl(u) {
  if (!/^https?:\/\//i.test(u)) return false;
  try {
    const parsed = new URL(u);
    if (!/^[\w.-]+$/.test(parsed.hostname)) return false;
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch { return false; }
}

// ---------- 模板检查 ----------
// 返回 { ok, errors:[{code,message}], warnings:[...], links:[...] }
export function checkTemplate({ subject, preheader = '', bodyHtml }) {
  const errors = [];
  const warnings = [];
  if (!subject || !subject.trim()) errors.push({ code: 'subject_empty', message: '主题不能为空' });
  if (!bodyHtml || !bodyHtml.trim()) errors.push({ code: 'body_empty', message: '正文不能为空' });
  if (bodyHtml && bodyHtml.length > 500_000) errors.push({ code: 'body_too_large', message: '正文过大' });

  const links = bodyHtml ? collectLinks(bodyHtml) : [];

  // 退订入口必须存在且可见（锚文本不能为空/隐藏）
  const unsubLinks = links.filter((l) => l.protected);
  if (unsubLinks.length === 0) {
    errors.push({ code: 'no_unsubscribe', message: '模板缺少退订入口（需要包含退订链接）' });
  } else {
    const visibleRe = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;
    let m; const anchors = [];
    while ((m = visibleRe.exec(bodyHtml))) anchors.push(m);
    const hasVisibleUnsub = anchors.some((a) => {
      const isUnsub = isUnsubscribeHref(a[0].match(/href\s*=\s*(["'])([\s\S]*?)\1/i)[2]);
      const text = a[1].replace(/<[^>]+>/g, '').trim();
      const hidden = /display\s*:\s*none|visibility\s*:\s*hidden/i.test(a[0]);
      return isUnsub && text.length > 0 && !hidden;
    });
    if (!hasVisibleUnsub) errors.push({ code: 'unsubscribe_hidden', message: '退订链接被隐藏或没有可见文案' });
  }

  // 链接安全：http(s) 才允许改写/跳转；禁止 javascript: 等
  for (const l of links) {
    const href = l.href.trim();
    if (l.protected) continue; // 退订/系统链接单独信任
    if (/^\{\{/.test(href)) continue; // 变量链接按运行时值校验
    if (href.startsWith('mailto:') || href.startsWith('#') || href.startsWith('/')) {
      warnings.push({ code: 'non_http_link', message: `非 http(s) 链接将不被跟踪：${href.slice(0, 60)}` });
      continue;
    }
    if (!validateUrl(href)) {
      errors.push({ code: 'unsafe_link', message: `非法或不安全的链接：${href.slice(0, 60)}` });
    }
  }

  // 可读性：浅色 + 深色两套背景都要达标
  const declarations = extractColorDeclarations(bodyHtml || '');
  const lightBg = [255, 255, 255], darkBg = [18, 18, 20];
  for (const d of declarations) {
    if (!d.fg) continue;
    const bg = d.bg || lightBg;
    if (contrastRatio(d.fg, bg) < 4.5) {
      warnings.push({ code: 'low_contrast_light', message: `<${d.tag}> 文字在其背景上对比度不足 4.5:1` });
    }
    // 未显式提供深色样式时，深色文字在深色背景上不可读
    if (!d.bg && contrastRatio(d.fg, darkBg) < 4.5) {
      errors.push({ code: 'dark_unreadable', message: `<${d.tag}> 深色模式下不可读（前景色过深且缺少深色背景声明）` });
    }
  }
  for (const block of extractDarkBlocks(bodyHtml || '')) {
    const bodyRe = /\{([^{}]*)\}/g;
    let bm;
    while ((bm = bodyRe.exec(block))) {
      const decls = bm[1];
      const fgM = /(^|;)\s*color\s*:\s*([^;]+)/i.exec(decls);
      const bgM = /background(?:-color)?\s*:\s*([^;]+)/i.exec(decls);
      if (fgM) {
        const fg = parseColor(fgM[2]);
        const bg = bgM ? parseColor(bgM[1]) : darkBg;
        if (fg && bg && contrastRatio(fg, bg) < 4.5) {
          errors.push({ code: 'dark_unreadable', message: '深色模式样式块内文字对比度不足' });
        }
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    links: links.map((l) => ({ href: l.href, protected: l.protected })),
  };
}

// ---------- 短链改写（退订地址永不改写） ----------
export function hashForUrl(url) {
  return crypto.createHash('sha1').update(url).digest('hex').slice(0, 12);
}
export function appendTracking(url, tracking) {
  if (!tracking || Object.keys(tracking).length === 0) return url;
  try {
    const u = new URL(url);
    for (const [k, v] of Object.entries(tracking)) u.searchParams.set(k, String(v));
    return u.toString();
  } catch { return url; }
}

// registerUrl(batchId,url) -> 短链完整 URL；仅在首次出现时持久化
export function rewriteLinks({ html, publicBase, batchToken, tracking, registerUrl }) {
  let droppedUnsub = false;
  const out = html.replace(/(<a\b[^>]*?\bhref\s*=\s*)(["'])([\s\S]*?)\2/gi, (whole, pre, q, href) => {
    const tagStart = whole;
    const protectedTag = /data-no-rewrite\b/i.test(tagStart) || isUnsubscribeHref(href);
    if (protectedTag) {
      // 安全断言：退订地址必须原样保留
      if (isUnsubscribeHref(href) && !whole.includes(href)) droppedUnsub = true;
      return whole;
    }
    let url = href;
    const isVar = /^\{\{.*\}\}$/.test(href.trim());
    if (isVar) return whole; // 变量链接运行时处理（发布校验已限制）
    if (!validateUrl(url)) return whole; // mailto/#/相对路径不动
    url = appendTracking(url, tracking);
    const shortPath = registerUrl ? registerUrl(url) : `/c/${batchToken}/l/${hashForUrl(url)}`;
    const shortUrl = `${publicBase}${shortPath}`;
    return `${pre}${q}${shortUrl}${q}`;
  });
  if (droppedUnsub) throw new Error('unsubscribe link dropped during rewrite');
  // 改写后完整性复核：原退订 href 仍在
  for (const l of collectLinks(html)) {
    if (l.protected && !out.includes(l.href)) {
      throw new Error('unsubscribe link missing after rewrite');
    }
  }
  return out;
}

// 渲染完整 HTML（变量替换 + 短链改写分离）
export function renderHtml(template, vars, opts = {}) {
  const rendered = renderString(template, vars);
  if (!opts.publicBase) return rendered;
  return rewriteLinks({
    html: rendered,
    publicBase: opts.publicBase,
    batchToken: opts.batchToken,
    tracking: opts.tracking,
    registerUrl: opts.registerUrl,
  });
}
