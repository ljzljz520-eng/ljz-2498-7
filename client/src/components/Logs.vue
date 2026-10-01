<script setup>
import { ref, onMounted } from 'vue';
import { api } from '../lib/api.js';
const batches = ref([]);
const batchId = ref(null);
const logs = ref(null);
async function loadBatches() {
  batches.value = await api.get('/api/batches');
  if (!batchId.value && batches.value[0]) { batchId.value = batches.value[0].id; await loadLogs(); }
}
async function loadLogs() {
  if (!batchId.value) return;
  logs.value = await api.get(`/api/batches/${batchId.value}/log`);
}
onMounted(loadBatches);
</script>
<template>
  <div class="panel">
    <div class="row">
      <strong>投递事件日志</strong>
      <select v-model.number="batchId" @change="loadLogs" style="max-width:300px">
        <option v-for="b in batches" :key="b.id" :value="b.id">#{{ b.id }} {{ b.campaign_name }}</option>
      </select>
      <button class="btn secondary" @click="loadLogs">刷新</button>
    </div>
    <p class="small" style="margin-top:8px">日志仅记录事件类型、邮箱与状态码；个性化变量值与渲染正文不会写入日志。</p>
    <div v-if="logs" style="margin-top:8px">
      <div v-for="(l,i) in logs" :key="i" class="logline">
        {{ new Date(l.created_at).toLocaleTimeString() }} · {{ l.email }} · <strong>{{ l.event }}</strong>
        <span class="small">{{ l.detail }}</span>
      </div>
      <p v-if="!logs.length" class="small">暂无事件</p>
    </div>
  </div>
</template>
