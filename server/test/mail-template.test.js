import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeHtml, renderString, checkTemplate, rewriteLinks, isUnsubscribeHref, contrastRatio,
} from '../src/mail-template.js';

test('个性化值按 HTML 上下文转义', () => {
  assert.equal(escapeHtml('<script>x</script>'), '&lt;script&gt;x&lt;/script&gt;');
  const out = renderString('<p>{{name}}</p>', { name: '<img src=x onerror=alert(1)>' });
  assert.ok(!out.includes('<img'));
  assert.ok(out.includes('&lt;img'));
  // URL 过滤器
  const u = renderString('<a href="{{x|u}}">', { x: 'a b"c' });
  const href = u.match(/href="([^"]*)"/)[1];
  assert.ok(!href.includes(' ') && !href.includes('"'));
  // 非可信变量不能用 raw 三括号
  const raw = renderString('{{{evil}}}', { evil: '<script>' });
  assert.equal(raw, '{{{evil}}}');
  // 可信系统变量允许 raw
  assert.equal(renderString('{{{unsubscribe_url}}}', { unsubscribe_url: '/u/tok' }), '/u/tok');
});

test('缺少退订入口时报错', () => {
  const r = checkTemplate({ subject: 's', bodyHtml: '<p style="color:#111;background:#fff">hi <a href="https://a.test">a</a></p>' });
  assert.ok(r.errors.some((e) => e.code === 'no_unsubscribe'));
  assert.equal(r.ok, false);
});

test('退订入口隐藏也报错', () => {
  const html = `<p style="color:#111;background:#fff">x
    <a data-no-rewrite style="display:none" href="http://x/unsubscribe"></a></p>`;
  const r = checkTemplate({ subject: 's', bodyHtml: html });
  assert.ok(r.errors.some((e) => e.code === 'unsubscribe_hidden'));
});

test('深色模式不可读被检出（深色前景且无深色背景声明）', () => {
  const html = `
    <p style="color:#0b1220;">深色文字</p>
    <p><a data-no-rewrite href="https://x/u">退订</a></p>`;
  const r = checkTemplate({ subject: 's', bodyHtml: html });
  assert.ok(r.errors.some((e) => e.code === 'dark_unreadable'), JSON.stringify(r.errors));
});

test('正常模板通过：浅深对比足够、退订可见、链接合法', () => {
  const html = `
    <h1 style="color:#111;background:#fff;">Hi</h1>
    <p style="color:#e8eaed;background:#121214;">深色块文字</p>
    <p><a href="https://example.test/a">商品</a></p>
    <p><a data-no-rewrite href="{{{unsubscribe_url}}}">退订</a></p>
    <style>@media (prefers-color-scheme: dark){ p{color:#e8eaed;background-color:#121214;} }</style>`;
  const r = checkTemplate({ subject: 's', bodyHtml: html });
  assert.deepEqual(r.errors, [], JSON.stringify(r.errors));
});

test('非法链接被拒（javascript: 等）', () => {
  const html = `<p style="color:#111;background:#fff">
    <a href="javascript:alert(1)">x</a>
    <a data-no-rewrite href="https://x/unsubscribe">退订</a></p>`;
  const r = checkTemplate({ subject: 's', bodyHtml: html });
  assert.ok(r.errors.some((e) => e.code === 'unsafe_link'));
});

test('短链改写不触碰退订地址，且改写后退订链接仍存在', () => {
  const html = `
    <p><a href="https://example.test/p1?a=1">商品1</a></p>
    <p><a href="https://example.test/p2">商品2</a></p>
    <p><a data-no-rewrite href="https://mail.test/u/abc?c=1">退订</a></p>
    <p><a href="http://mail.test/unsubscribe?x=1">退订2（按路径识别）</a></p>`;
  const seen = new Map();
  const out = rewriteLinks({
    html, publicBase: 'http://localhost', batchToken: 'btok', tracking: { utm_source: 'camp' },
    registerUrl: (url) => { const k = '/s/' + seen.size; seen.set(url, k); return k; },
  });
  // 普通链接被换成短链
  assert.ok(out.includes('http://localhost/s/0'));
  assert.ok(!/href="https:\/\/example\.test\/p1/.test(out));
  // 退订链接原样保留（未进入短链表，未追加跟踪参数）
  assert.ok(out.includes('href="https://mail.test/u/abc?c=1"'));
  assert.ok(out.includes('href="http://mail.test/unsubscribe?x=1"'));
  // 普通链接带跟踪参数登记
  const urls = [...seen.keys()];
  assert.ok(urls.some((u) => u.includes('utm_source=camp')));
  assert.ok(!urls.some((u) => u.includes('unsubscribe')));
});

test('对比度计算：白字白底不可读', () => {
  assert.ok(contrastRatio([255, 255, 255], [255, 255, 255]) < 2);
  assert.ok(contrastRatio([0, 0, 0], [255, 255, 255]) > 18);
});
