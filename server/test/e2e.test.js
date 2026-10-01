import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startSimulator, startApi, api, sleep, GOOD_HTML, DARK_BAD_HTML } from './helpers.js';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mailcamp-e2e-'));
const API_PORT = 5674, SMTP_PORT = 2625, SIM_HTTP = 2626;
let simProc, apiProc, seq = 0;

const simCtl = (method, p, body) =>
  fetch(`http://127.0.0.1:${SIM_HTTP}${p}`, {
    method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  }).then((r) => r.json());

async function waitFor(fn, { tries = 100, interval = 100, label = 'condition' } = {}) {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    await sleep(interval);
  }
  throw new Error('timeout waiting for ' + label);
}

async function createCampaign() {
  const { json } = await api(API_PORT, 'POST', '/api/campaigns', { name: 'E2E ' + (++seq), groupName: 'growth' });
  return json.id;
}
async function createAudience(rows) {
  const csv = rows.join('\n');
  const { json } = await api(API_PORT, 'POST', '/api/audiences', { name: 'aud-' + (++seq), csv });
  return json.id;
}
async function publish(cid, bodyHtml, extra = {}) {
  const r = await api(API_PORT, 'POST', `/api/campaigns/${cid}/publish`, {
    subject: 'Hi {{name}}', preheader: 'p {{city}}', bodyHtml, tracking: { utm_source: 'e2e' }, ...extra,
  });
  assert.equal(r.status, 200, 'publish should succeed: ' + JSON.stringify(r.json));
  return r.json.id;
}
async function fullBatch({ emails, html = GOOD_HTML(), userId = 1, groupId = null, ready = true, send = true }) {
  const cid = await createCampaign();
  const aid = await createAudience(emails);
  const tplId = await publish(cid, html);
  const b = await api(API_PORT, 'POST', '/api/batches', { campaignId: cid, templateVersionId: tplId, audienceId: aid, groupId }, userId);
  assert.equal(b.status, 200, JSON.stringify(b.json));
  const bid = b.json.id;
  if (ready) {
    const r = await api(API_PORT, 'POST', `/api/batches/${bid}/ready`, {}, userId);
    assert.equal(r.status, 200);
  }
  if (send) {
    const r = await api(API_PORT, 'POST', `/api/batches/${bid}/send`, {}, userId);
    assert.equal(r.status, 200);
  }
  return bid;
}
const getBatch = (id) => api(API_PORT, 'GET', `/api/batches/${id}`).then((r) => r.json);

before(async () => {
  simProc = await startSimulator(DATA, SMTP_PORT, SIM_HTTP);
  apiProc = await startApi(DATA, API_PORT, SMTP_PORT);
  await simCtl('POST', '/reset');
});
after(async () => {
  apiProc?.kill(); simProc?.kill();
  await sleep(100);
});

// ---------- 1. 深色不可读：阻止发布 ----------
test('深色不可读模板无法发布，且给出 dark_unreadable', async () => {
  const cid = await createCampaign();
  const r = await api(API_PORT, 'POST', `/api/campaigns/${cid}/publish`, {
    subject: 's', preheader: '', bodyHtml: DARK_BAD_HTML(),
  });
  assert.equal(r.status, 422);
  assert.ok(r.json.check.errors.some((e) => e.code === 'dark_unreadable'));
});

// ---------- 2. 无退订入口：阻止发布 ----------
test('没有退订入口的模板无法发布', async () => {
  const cid = await createCampaign();
  const html = `<h1 style="color:#111;background:#fff;">Hi</h1>
    <p><a href="https://example.test/x">商品</a></p>`;
  const r = await api(API_PORT, 'POST', `/api/campaigns/${cid}/publish`, { subject: 's', bodyHtml: html });
  assert.equal(r.status, 422);
  assert.ok(r.json.check.errors.some((e) => e.code === 'no_unsubscribe'));
});

// ---------- 3. 分组越权：Alice 不能使用 billing 组 ----------
test('分组越权：growth 组成员不能创建 billing 组批次（admin 可以）', async () => {
  const cid = await createCampaign();
  const aid = await createAudience(['ok1@example.test,One,city=X']);
  const tplId = await publish(cid, GOOD_HTML());
  // seed 中组 id=2 billing；Alice(user 1) 只在 growth(1)
  const denied = await api(API_PORT, 'POST', '/api/batches',
    { campaignId: cid, templateVersionId: tplId, audienceId: aid, groupId: 2 }, 1);
  assert.equal(denied.status, 403);
  assert.equal(denied.json.error, 'group_forbidden');
  // admin(3) 允许
  const allowed = await api(API_PORT, 'POST', '/api/batches',
    { campaignId: cid, templateVersionId: tplId, audienceId: aid, groupId: 2 }, 3);
  assert.equal(allowed.status, 200);
});

// ---------- 4. 响应丢失后重投：幂等，模拟器仅收到一封 ----------
test('应答丢失触发重投，凭 message-id 幂等，收件箱只有一封', async () => {
  const email = `drop-${Date.now()}@example.test`;
  await simCtl('POST', '/faults', { match: email, type: 'drop_response', stage: 'data', once: true });
  const bid = await fullBatch({ emails: [`${email},Dropper,city=S`] });
  await waitFor(async () => {
    const d = await getBatch(bid);
    return d.recipients[0].status === 'confirmed';
  }, { label: 'confirmed after redelivery' });
  const d = await getBatch(bid);
  assert.equal(d.recipients[0].status, 'confirmed');
  assert.ok(d.recipients[0].attempts >= 2, 'should have retried: ' + d.recipients[0].attempts);
  await sleep(150);
  const msgs = await simCtl('GET', `/messages?to=${encodeURIComponent(email)}`);
  assert.equal(msgs.length, 1, 'simulator must receive exactly one message');
  // 退订链接在最终邮件中保留，且未被短链改写
  const full = await fetch(`http://127.0.0.1:${SIM_HTTP}/messages/${encodeURIComponent(msgs[0].messageId)}`).then((r) => r.json());
  assert.equal(full.duplicateDeliveries, 1, 'simulator saw a redelivery but dedups by message-id');
  assert.equal(full.hasUnsubscribeUrl, true, 'unsubscribe url present in delivered mail');
  assert.equal(full.unsubscribeRewrittenAsShortlink, false, 'unsubscribe not rewritten to short link');
  // 列表接口绝不返回正文全文
  assert.ok(!JSON.stringify(msgs[0]).includes('<h1'), 'inbox list must not expose body');
});

// ---------- 4b. 451 临时失败后重试成功 ----------
test('451 临时失败后自动重试并确认', async () => {
  const email = `temp-${Date.now()}@example.test`;
  await simCtl('POST', '/faults', { match: email, type: 'tempfail', stage: 'data', once: true });
  const bid = await fullBatch({ emails: [`${email},Tempy,city=T`] });
  await waitFor(async () => (await getBatch(bid)).recipients[0].status === 'confirmed', { label: 'tempfail recover' });
  const msgs = await simCtl('GET', `/messages?to=${encodeURIComponent(email)}`);
  assert.equal(msgs.length, 1);
});

// ---------- 5. 渲染进程退出：任务自动换进程重试成功 ----------
test('渲染子进程崩溃后池自动重启，校验请求仍成功', async () => {
  fs.writeFileSync(path.join(DATA, 'render-crash-once'), '1');
  const r = await api(API_PORT, 'POST', '/api/check', { subject: 's', bodyHtml: GOOD_HTML(), crash: true });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.ok(r.json.pool.crashes >= 1, 'pool should record a crash: ' + JSON.stringify(r.json.pool));
  assert.ok(r.json.pool.restarts >= 1);
});

// ---------- 6. 确认后退订竞态 + 领取时复查 ----------
test('发送前已退订者在整批快照/领取时被抑制；确认后退订不撤回投递', async () => {
  const earlyUnsub = `early-${Date.now()}@example.test`;
  const lateUnsub = `late-${Date.now()}@example.test`;
  const normal = `normal-${Date.now()}@example.test`;

  // late 的回执先挂起：消息已送达模拟器，但 250 在测试放行后才发
  await simCtl('POST', '/holds', { email: lateUnsub });

  // early 在 ready 前就退订 -> 整批快照阶段抑制
  await api(API_PORT, 'POST', '/api/unsubscribe', { email: earlyUnsub });
  const bid = await fullBatch({
    emails: [`${earlyUnsub},Early,city=E`, `${lateUnsub},Late,city=L`, `${normal},Norm,city=N`],
    send: false,
  });
  let d = await getBatch(bid);
  assert.equal(d.recipients.find((r) => r.email === earlyUnsub).status, 'suppressed');

  await api(API_PORT, 'POST', `/api/batches/${bid}/send`);

  // late 被顺序处理：等待邮件真正到达模拟器（但回执仍挂起），此时其状态为 attempted
  await waitFor(async () => {
    const held = await simCtl('GET', '/holds');
    return held[lateUnsub.toLowerCase()]?.arrived === true;
  }, { label: 'late message arrived and held' });
  const x0 = await getBatch(bid);
  assert.equal(x0.recipients.find((r) => r.email === lateUnsub).status, 'attempted');

  // 此时邮件实际已被 MTA 接收（响应尚未返回），在“确认前一刻”退订
  await api(API_PORT, 'POST', '/api/unsubscribe', { email: lateUnsub });

  // 放行 250 -> 客户端把该收件人标记为 confirmed（确认发生在退订登记之后）
  const released = await simCtl('POST', `/holds/${encodeURIComponent(lateUnsub)}/release`);
  assert.equal(released.messageArrived, true);
  await waitFor(async () => (await getBatch(bid)).recipients.find((r) => r.email === lateUnsub).status === 'confirmed',
    { label: 'late confirmed after unsubscribe' });
  await waitFor(async () => ['done', 'done_with_failures'].includes((await getBatch(bid)).batch.status),
    { label: 'batch terminal' });

  d = await getBatch(bid);
  const byEmail = Object.fromEntries(d.recipients.map((r) => [r.email, r]));
  assert.equal(byEmail[normal].status, 'confirmed');
  assert.equal(byEmail[earlyUnsub].status, 'suppressed');
  // 已送达的邮件不撤回：confirmed 保留
  assert.equal(byEmail[lateUnsub].status, 'confirmed');
  assert.equal(byEmail[normal].status, 'confirmed');

  // 日志必须记录“确认后退订”竞态，且个性化正文不入日志
  const logs = await api(API_PORT, 'GET', `/api/batches/${bid}/log`).then((r) => r.json);
  assert.ok(logs.some((l) => l.event === 'unsubscribed_after_confirm' && l.email === lateUnsub),
    'unsubscribed_after_confirm event required');
  assert.ok(!JSON.stringify(logs).includes('Late'));

  // late 只收到一封；快照/领取阶段被抑制的 early 没有邮件
  const lateMsgs = await simCtl('GET', `/messages?to=${encodeURIComponent(lateUnsub)}`);
  assert.equal(lateMsgs.length, 1);
  const earlyMsgs = await simCtl('GET', `/messages?to=${encodeURIComponent(earlyUnsub)}`);
  assert.equal(earlyMsgs.length, 0, 'snapshot-suppressed recipient must not be sent');
});

// ---------- 7. 领取时复查：ready 之后、真正领取前退订 ----------
test('候选批就绪后退订，领取任务瞬间复查并抑制（不发送）', async () => {
  const email = `claim-${Date.now()}@example.test`;
  const bid = await fullBatch({ emails: [`${email},Claim,city=C`], send: false });
  // ready 之后、send 之前退订
  await api(API_PORT, 'POST', '/api/unsubscribe', { email });
  await api(API_PORT, 'POST', `/api/batches/${bid}/send`);
  await waitFor(async () => ['done', 'done_with_failures'].includes((await getBatch(bid)).batch.status));
  const d = await getBatch(bid);
  assert.equal(d.recipients[0].status, 'suppressed');
  const msgs = await simCtl('GET', `/messages?to=${encodeURIComponent(email)}`);
  assert.equal(msgs.length, 0);
  // 快照对比可观察到漂移
  const diff = await api(API_PORT, 'GET', `/api/batches/${bid}/diff`).then((r) => r.json);
  assert.equal(diff.same, false);
  assert.ok(diff.changed.some((c) => c.email === email && c.from === 'S' && c.to === 'U'));
});

// ---------- 7. 三态可观察 + 日志不泄露个性化正文 ----------
test('前端可观察 prepared/attempted/confirmed 三态，日志不含个性化正文', async () => {
  const email = `states-${Date.now()}@example.test`;
  const bid = await fullBatch({ emails: [`${email},状态用户,city=秘密城市`] });
  await waitFor(async () => (await getBatch(bid)).recipients[0].status === 'confirmed');
  const logs = await api(API_PORT, 'GET', `/api/batches/${bid}/log`).then((r) => r.json);
  const events = logs.map((l) => l.event);
  for (const ev of ['prepared', 'attempted', 'confirmed']) assert.ok(events.includes(ev), ev + ' missing');
  const serialized = JSON.stringify(logs);
  assert.ok(!serialized.includes('秘密城市'), 'logs must not contain personalization values');
  assert.ok(!serialized.includes('<h1'), 'logs must not contain rendered body');
});

// ---------- 8. 短链跳转 + 跟踪参数冻结 + 退订链接保护 ----------
test('短链 302 到带跟踪参数的原始 URL；退订链接从不入短链表', async () => {
  const bid = await fullBatch({ emails: [`link-${Date.now()}@example.test,Linky,city=Z`] });
  await waitFor(async () => (await getBatch(bid)).recipients[0].status === 'confirmed');
  await sleep(100);
  const links = await api(API_PORT, 'GET', `/api/batches/${bid}/links`).then((r) => r.json);
  // 商品链接进短链表；退订链接绝不进入
  assert.equal(links.length, 1, JSON.stringify(links));
  assert.ok(links[0].url.startsWith('https://example.test/products?'));
  assert.ok(links[0].url.includes('utm_source=e2e'));
  assert.ok(links[0].url.includes(`batch=${(await getBatch(bid)).batch.token}`));
  assert.ok(!links.some((l) => /unsubscribe|\/u\//.test(l.url)), 'unsubscribe must not be a tracked short link');
  const res = await fetch(`http://localhost:${API_PORT}/c/link/${bid}/${links[0].url_hash}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), links[0].url);
});
