import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapCampaign, jsonFetch, startTestHarness } from './helpers.js';

const harness = await startTestHarness();
after(() => harness.stop());

test('整批快照可发现受众版本漂移；退订接口只写确认记录与成员状态', async () => {
  const setup = await bootstrapCampaign(harness);
  const initial = await harness.worker.reconcileOpenBatches();
  assert.equal(initial[0].snapshot_checksum_matches, true);

  await harness.db.transaction((tx) => {
    tx.insert('audience_members', {
      group_id: setup.group.id,
      email: 'newcomer@example.test',
      name: 'New',
      subscribed: true,
      subscribed_at: new Date().toISOString(),
      unsubscribed_at: null,
      version: 2,
    });
  });
  const drifted = await harness.worker.reconcileOpenBatches();
  assert.equal(drifted[0].snapshot_checksum_matches, false);
  assert.ok(drifted[0].drift >= 1);

  const recipientTask = await harness.db.read((tx) => tx.get('recipient_tasks', setup.recipientTask.id));
  const token = recipientTask.personalization_snapshot.unsubscribe_token;
  const response = await fetch(`${harness.base}/unsubscribe/${encodeURIComponent(token)}`, { method: 'POST' });
  assert.equal(response.status, 200);
  const member = await harness.db.read((tx) => tx.get('audience_members', setup.member.id));
  assert.equal(member.subscribed, false);
  const record = await harness.db.read((tx) => tx.find('unsubscribe_records', (record) => record.recipient_member_id === setup.member.id));
  assert.ok(record.confirmed_at);
});
