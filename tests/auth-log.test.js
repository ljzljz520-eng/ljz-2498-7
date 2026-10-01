import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { startTestHarness, jsonFetch, validTemplate } from './helpers.js';
import { safeLogger } from '../backend/security/redact.js';

const harness = await startTestHarness();
after(() => harness.stop());

test('分组越权不能读取或发送其他分组活动', async () => {
  const setup = await bootstrapOwnedCampaign(harness);
  const { body: groups } = await jsonFetch(`${harness.base}/api/groups`);
  const reader = groups.find((group) => group.name === 'analytics-readers');

  const list = await jsonFetch(`${harness.base}/api/campaigns/${setup.campaign.id}/versions`, {
    headers: { 'x-group-id': reader.id },
  });
  assert.equal(list.response.status, 403);

  const batch = await jsonFetch(`${harness.base}/api/batches`, {
    method: 'POST',
    headers: { 'x-group-id': reader.id },
    body: { campaignId: setup.campaign.id, audienceVersionId: setup.audienceVersion.id },
  });
  assert.equal(batch.response.status, 403);
});

test('日志只保留标识，不输出个性化主题、正文或收件人内容', () => {
  const lines = [];
  const output = new Writable({ write(chunk, _, done) { lines.push(chunk.toString()); done(); } });
  const log = safeLogger({ log: (line) => lines.push(line + '\n') });
  log.error('send failed', {
    subject: 'Hello Ada <secret>',
    previewText: 'private preview',
    bodyHtml: '<p>secret personalized body</p>',
    email: 'ada@example.test',
    recipient: { name: 'Ada', body: 'secret' },
    batch_id: 'batch-123',
    task_id: 'task-123',
  });
  const text = lines.join('\n');
  assert.match(text, /batch-123/);
  assert.match(text, /task-123/);
  assert.doesNotMatch(text, /Ada|secret|private preview|ada@example\.test|personalized body/);
});

async function bootstrapOwnedCampaign(harness) {
  const { body: groups } = await jsonFetch(`${harness.base}/api/groups`);
  const owner = groups.find((group) => group.name === 'designers');
  const seeded = await jsonFetch(`${harness.base}/api/seed`, {
    method: 'POST',
    headers: { 'x-group-id': owner.id },
    body: { email: 'auth@example.test', name: 'Auth' },
  }).then((r) => r.body);
  const campaign = await jsonFetch(`${harness.base}/api/campaigns`, {
    method: 'POST',
    headers: { 'x-group-id': owner.id },
    body: { name: 'private', ownerGroupId: owner.id },
  }).then((r) => r.body);
  await jsonFetch(`${harness.base}/api/campaigns/${campaign.id}/publish`, {
    method: 'POST',
    headers: { 'x-group-id': owner.id },
    body: validTemplate(),
  });
  return { campaign, audienceVersion: seeded.version };
}
