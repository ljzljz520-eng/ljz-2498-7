import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statusLabels } from '../frontend/src/lib/status.js';

test('前端明确区分已准备、已尝试投递和已确认回执', () => {
  assert.equal(statusLabels.prepared.label, '已准备');
  assert.equal(statusLabels.attempted_delivery.label, '已尝试投递');
  assert.equal(statusLabels.confirmed_receipt.label, '已确认回执');
  assert.notEqual(statusLabels.prepared.label, statusLabels.confirmed_receipt.label);
});
