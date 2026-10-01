import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPublished, validateTemplate } from '../backend/templates/render.js';
import { validTemplate } from './helpers.js';

test('主题、预览、正文、跟踪参数在发布版渲染时保持同一版本', () => {
  const output = renderPublished(validTemplate(), {
    name: 'Ada',
    unsubscribe_token: 'tok.123',
  });
  assert.match(output.subject, /^Hello Ada$/);
  assert.match(output.html, /Ada has a secure update/);
  assert.match(output.html, /campaign=weekly-2026/);
  assert.match(output.html, /source=email/);
  const normal = output.links.find((link) => !link.unsubscribe);
  assert.equal(normal.final, 'https://example.com/news?campaign=weekly-2026&source=email');
});

test('个性化值按 HTML 与 URL 上下文转义', () => {
  const output = renderPublished(validTemplate(), {
    name: '<img src=x onerror=alert(1)> & "Ada"',
    unsubscribe_token: 'tok&a=<b>',
  });
  assert.match(output.html, /&lt;img src=x onerror=alert\(1\)&gt; &amp; &quot;Ada&quot;/);
  const unsubscribe = output.links.find((link) => link.unsubscribe);
  assert.ok(unsubscribe.final.startsWith('https://example.com/unsubscribe?unsubscribe_token='));
  assert.doesNotMatch(unsubscribe.final, /<|>/);
});

test('退订地址不得被短链或跟踪重写流程删掉或改写', () => {
  const output = renderPublished(validTemplate(), { name: 'Ada', unsubscribe_token: 'token-value' });
  const unsubscribe = output.links.find((link) => link.unsubscribe);
  assert.equal(unsubscribe.original, unsubscribe.final);
  assert.equal(unsubscribe.preserved, true);
  assert.doesNotMatch(unsubscribe.final, /campaign=weekly/);
  assert.match(output.html, /rel="unsubscribe"/);
});

test('深色低对比度和无退订入口会阻断发布', () => {
  const lowContrast = validateTemplate(validTemplate({
    bodyHtml: '<p style="color:#777;background:#888;">Hello</p><a rel="unsubscribe" href="https://x.test/unsubscribe?unsubscribe_token=t">x</a>',
  }));
  assert.equal(lowContrast.ok, false);
  assert.ok(lowContrast.errors.some((e) => e.code === 'LOW_CONTRAST'));

  const noUnsubscribe = validateTemplate(validTemplate({
    bodyHtml: '<div style="color:#111;background:#fff;">Hello {{name}}</div>',
  }));
  assert.equal(noUnsubscribe.ok, false);
  assert.ok(noUnsubscribe.errors.some((e) => e.code === 'UNSUBSCRIBE_REQUIRED'));
});

test('危险协议和内联事件处理器被拒绝', () => {
  const report = validateTemplate(validTemplate({
    bodyHtml: '<div style="color:#111;background:#fff;"><a onclick="alert(1)" href="javascript:alert(1)">x</a><a rel="unsubscribe" href="https://x.test/unsubscribe?unsubscribe_token=t">u</a></div>',
  }));
  assert.equal(report.ok, false);
  assert.deepEqual(new Set(report.errors.map((e) => e.code)), new Set(['EVENT_HANDLER', 'FORBIDDEN_PROTOCOL']));
});

test('发布前服务端接口同样拒绝深色不可读模板和无退订模板', async () => {
  const { RendererPool } = await import('../backend/renderer/render-pool.js');
  const renderer = new RendererPool({ timeoutMs: 2000 });
  try {
    const lowContrast = await renderer.validate(validTemplate({
      bodyHtml: '<p style="color:#777;background:#888;">x</p><a rel="unsubscribe" href="https://x.test/u?unsubscribe_token=t">u</a>',
    }));
    assert.equal(lowContrast.ok, false);
    assert.ok(lowContrast.errors.some((error) => error.code === 'LOW_CONTRAST'));
  } finally {
    await renderer.stop();
  }
});
