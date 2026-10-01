<template>
  <article class="card" v-if="batch">
    <h2>逐收件人状态</h2>
    <div class="counts">
      <span v-for="(count, status) in batch.counts" :key="status" :class="['badge', tone(status)]">
        {{ label(status) }}：{{ count }}
      </span>
    </div>
    <table>
      <thead><tr><th>收件人</th><th>状态</th><th>尝试</th><th>下次重试</th><th>错误</th></tr></thead>
      <tbody>
        <tr v-for="task in batch.tasks" :key="task.id">
          <td>{{ task.email_override_at_snapshot }}</td>
          <td><span :class="['badge', tone(task.status)]">{{ label(task.status) }}</span></td>
          <td>{{ task.attempts }}</td>
          <td>{{ task.next_attempt_after || '—' }}</td>
          <td>{{ task.last_error_code || '—' }}</td>
        </tr>
      </tbody>
    </table>
  </article>
</template>
<script setup>
import { statusLabels } from '../lib/status.js';
defineProps({ batch: Object });
const label = (status) => statusLabels[status]?.label ?? status;
const tone = (status) => {
  if (status === 'confirmed_receipt') return 'ok';
  if (String(status).startsWith('failed')) return 'bad';
  if (status === 'attempted_delivery') return 'warning';
  return 'neutral';
};
</script>
