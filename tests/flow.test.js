import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapCampaign, jsonFetch, sleep, startTestHarness, validTemplate } from './helpers.js';

const targetTask = (batch, setup) => batch.tasks.find((task) => task.recipient_member_id === setup.member.id);

const harness = await startTestHarness();
after(() => harness.stop());

test('发送前复查模板，整批快照与逐收件人状态共同驱动幂等投递', async () => {
  const setup = await bootstrapCampaign(harness);
  const before = await jsonFetch(`${harness.base}/api/batches/${setup.batch.id}`, { headers: setup.headers }).then((r) => r.body);
  assert.equal(before.status, 'ready');
  assert.equal(before.counts.prepared, 1);

  const processed = await jsonFetch(`${harness.base}/api/batches/process?limit=5&taskId=${encodeURIComponent(setup.recipientTask.id)}`, { method: 'POST' }).then((r) => r.body);
  assert.ok(processed.results.some((r) => r.taskId === setup.recipientTask.id && r.status === 'confirmed_receipt'));
  const after = await jsonFetch(`${harness.base}/api/batches/${setup.batch.id}`, { headers: setup.headers }).then((r) => r.body);
  assert.equal(after.counts.confirmed_receipt, 1);
  assert.equal(targetTask(after, setup).attempts, 1);

  // Running again must not select a confirmed task or create another SMTP message.
  await jsonFetch(`${harness.base}/api/batches/process?limit=5`, { method: 'POST' });
  const recipient = setup.member.email;
  const messages = harness.mail.outbox.filter((m) => m.to.some((line) => line.includes(recipient)));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].duplicates, 0);
  assert.match(messages[0].messageId, /@campaign\.local>$/);
});

test('确认后退订发生在领取任务后、真正发送前时，逐收件人复查会跳过', async () => {
  const setup = await bootstrapCampaign(harness);
  const taskId = setup.recipientTask.id;
  const beforeMailCount = harness.mail.outbox.length;
  const originalAfterClaim = harness.worker.afterClaim;
  harness.worker.afterClaim = async (claimed) => {
    const target = claimed.find((row) => row.id === taskId);
    if (!target) return;
    const rawTask = await harness.db.read((tx) => tx.get('recipient_tasks', taskId));
    await harness.db.transaction((tx) => {
      const member = tx.get('audience_members', rawTask.recipient_member_id);
      tx.update('audience_members', member.id, { subscribed: false, unsubscribed_at: new Date().toISOString() });
    });
  };
  const result = await jsonFetch(`${harness.base}/api/batches/process?limit=10&taskId=${encodeURIComponent(taskId)}`, { method: 'POST' }).then((r) => r.body);
  harness.worker.afterClaim = null;
  assert.equal(result.results.find((r) => r.taskId === taskId).status, 'skipped_after_claim');
  const batch = await jsonFetch(`${harness.base}/api/batches/${setup.batch.id}`, { headers: setup.headers }).then((r) => r.body);
  assert.equal(batch.counts.skipped_after_claim, 1);
  assert.equal(harness.mail.outbox.length, beforeMailCount);
});

test('首个最终响应丢失后，使用稳定 Message-ID 重投，模拟器识别重复并确认回执', async () => {
  process.env.SMTP_SIMULATE_RESPONSE_LOST = 'first';
  try {
    const setup = await bootstrapCampaign(harness, validTemplate(), true);
    const first = await jsonFetch(`${harness.base}/api/batches/process?limit=5&taskId=${encodeURIComponent(setup.recipientTask.id)}`, { method: 'POST' }).then((r) => r.body);
    assert.equal(first.results.find((r) => r.taskId === setup.recipientTask.id).status, 'attempted_delivery');
    let batch = await jsonFetch(`${harness.base}/api/batches/${setup.batch.id}`, { headers: setup.headers }).then((r) => r.body);
    assert.equal(targetTask(batch, setup).status, 'attempted_delivery');
    assert.equal(targetTask(batch, setup).attempts, 1);
    await sleep(120);
    await jsonFetch(`${harness.base}/api/batches/process?limit=5&taskId=${encodeURIComponent(setup.recipientTask.id)}`, { method: 'POST' });
    batch = await jsonFetch(`${harness.base}/api/batches/${setup.batch.id}`, { headers: setup.headers }).then((r) => r.body);
    assert.equal(targetTask(batch, setup).status, 'confirmed_receipt');
    assert.equal(targetTask(batch, setup).attempts, 2);
    const messages = harness.mail.outbox
      .filter((m) => m.to.some((line) => line.includes(setup.member.email)))
      .filter((m) => m.messageId === `<${targetTask(batch, setup).message_id}>`);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].duplicates, 1);
  } finally {
    delete process.env.SMTP_SIMULATE_RESPONSE_LOST;
  }
});

test('渲染子进程退出后当前任务可重试，重启渲染进程后确认', async () => {
  const setup = await bootstrapCampaign(harness);
  const taskId = setup.recipientTask.id;
  let crashed = false;
  harness.worker.afterClaim = async (claimed) => {
    if (claimed.some((row) => row.id === taskId) && !crashed) {
      crashed = true;
      await harness.db.transaction((tx) => {
        const task = tx.get('recipient_tasks', taskId);
        tx.update('recipient_tasks', taskId, {
          personalization_snapshot: { ...task.personalization_snapshot, __crashOnce: true },
        });
      });
    }
  };
  const first = await jsonFetch(`${harness.base}/api/batches/process?limit=5&taskId=${encodeURIComponent(setup.recipientTask.id)}`, { method: 'POST' }).then((r) => r.body);
  assert.equal(first.results.find((r) => r.taskId === taskId).status, 'attempted_delivery');
  harness.worker.afterClaim = null;
  await sleep(120);
  await harness.db.transaction((tx) => {
    const task = tx.get('recipient_tasks', taskId);
    const { __crashOnce, ...personalization } = task.personalization_snapshot;
    tx.update('recipient_tasks', taskId, { personalization_snapshot: personalization });
  });
  await jsonFetch(`${harness.base}/api/batches/process?limit=5&taskId=${encodeURIComponent(taskId)}`, { method: 'POST' });
  const batch = await jsonFetch(`${harness.base}/api/batches/${setup.batch.id}`, { headers: setup.headers }).then((r) => r.body);
  assert.equal(targetTask(batch, setup).status, 'confirmed_receipt');
  assert.ok(targetTask(batch, setup).attempts >= 2);
});
